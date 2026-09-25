"""Themed PDF album export, laid out as a bento grid.

Design decisions that matter:

- **Bento, not a grid.** Each page places photos on a 12x12 unit grid with mixed
  spans, so one or two tiles dominate and the rest form a rhythm around them.
  Templates tile the grid exactly (asserted by the test suite), and pages
  alternate between variants so a long album never settles into one beat.
- **Captions sit under the photo, never on it.** An earlier version drew a dark
  scrim inside each tile and muddied every image. Labels now live in the gutter
  beneath the tile, set in the theme's ink on the page background, so photos are
  reproduced exactly as they are.
- **Themes travel as a unit** — palette, page gradient, film grain, rule weights
  and display typeface change together.
- **Captions can be written by the text model.** `caption_photos()` asks for a
  short, concrete title per photo; it is optional and falls back to event labels
  on any failure.

Rendering is a Pillow/ReportLab split: Pillow does pixel work (gradients,
cover-crops, rounded masks, shadows), ReportLab does vector type, rules and page
structure, so text stays crisp at print resolution. Slot composites are embedded
as JPEG rather than alpha PNG — with alpha, ReportLab falls back to lossless
Flate and a three-page album ballooned to ~9 MB.
"""
from __future__ import annotations

import io
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Sequence

from PIL import Image, ImageDraw, ImageFilter, ImageOps
from reportlab.lib.colors import Color
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas as pdfcanvas

# A4 landscape: album-shaped, prints anywhere.
PAGE_W, PAGE_H = landscape(A4)
MARGIN = 38.0
GUTTER = 11.0
CORNER_RADIUS = 9.0

# Space reserved beneath each tile for its label.
CAPTION_H = 20.0
CAPTION_GAP = 5.0

# Cover preview band, as a fraction of page height and an offset from the foot.
COVER_STRIP_FRACTION = 0.43
COVER_STRIP_BOTTOM = MARGIN + 15

TARGET_DPI = 200.0
BG_DPI = 110.0
JPEG_QUALITY = 88
SHADOW_BLEED = 6.0


def _hex(value: str, alpha: float = 1.0) -> Color:
    value = value.lstrip("#")
    r, g, b = (int(value[i : i + 2], 16) / 255.0 for i in (0, 2, 4))
    return Color(r, g, b, alpha=alpha)


def _rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


@dataclass(frozen=True)
class Theme:
    key: str
    name: str
    bg_top: str
    bg_bottom: str
    ink: str
    muted: str
    accent: str
    frame: str
    grain: float
    display_serif: bool
    dark: bool
    #: Pure paper: no gradient, no glow, no grain, no drop shadow and square
    #: corners. 小黑's style DNA forbids all of them (纯白背景，不要渐变、阴影、
    #: 噪点), and a rounded card with a shadow is web furniture, not print.
    flat: bool = False

    @property
    def shadow_alpha(self) -> float:
        if self.flat:
            return 0.0
        return 0.40 if self.dark else 0.16

    @property
    def radius(self) -> float:
        return 0.0 if self.flat else CORNER_RADIUS

    @property
    def keyline(self) -> float:
        """Flat themes carry the tile edge with a hairline instead of a shadow."""
        return 0.9 if self.flat else 0.5


THEMES: dict[str, Theme] = {
    "midnight": Theme(
        key="midnight", name="Midnight", bg_top="#141824", bg_bottom="#070910",
        ink="#f4f6fb", muted="#8b95ac", accent="#d8b26a", frame="#2b3243",
        grain=0.5, display_serif=True, dark=True,
    ),
    "ivory": Theme(
        key="ivory", name="Ivory", bg_top="#fcfaf7", bg_bottom="#efe9df",
        ink="#1b1a18", muted="#8c8478", accent="#b0814f", frame="#e2dacd",
        grain=0.2, display_serif=True, dark=False,
    ),
    "blush": Theme(
        key="blush", name="Blush", bg_top="#fdf3f2", bg_bottom="#f6dfe4",
        ink="#40282d", muted="#a57883", accent="#d97b8c", frame="#f1d1d7",
        grain=0.16, display_serif=False, dark=False,
    ),
    "mono": Theme(
        key="mono", name="Mono", bg_top="#ffffff", bg_bottom="#f1f1f1",
        ink="#0a0a0a", muted="#8c8c8c", accent="#0a0a0a", frame="#dddddd",
        grain=0.0, display_serif=False, dark=False,
    ),
    "forest": Theme(
        key="forest", name="Forest", bg_top="#16211c", bg_bottom="#080e0b",
        ink="#eef4ef", muted="#87a094", accent="#9dc4a3", frame="#26362d",
        grain=0.42, display_serif=True, dark=True,
    ),
    # Built for 小黑. Pure white, hairline rules, and an orange reserved for
    # flow and annotation the way the style DNA uses it (橙色：主流程、路径).
    "paper": Theme(
        key="paper", name="Paper", bg_top="#ffffff", bg_bottom="#ffffff",
        ink="#141414", muted="#9a9a9a", accent="#e2542c", frame="#141414",
        grain=0.0, display_serif=False, dark=False, flat=True,
    ),
}
DEFAULT_THEME = "midnight"


# Bento templates on a 12x12 unit grid, as (col, row, colspan, rowspan).
# Every template tiles the grid exactly - test_collage.py asserts it.
BENTO: dict[int, list[list[tuple[int, int, int, int]]]] = {
    1: [[(0, 0, 12, 12)]],
    2: [
        [(0, 0, 7, 12), (7, 0, 5, 12)],
        [(0, 0, 12, 7), (0, 7, 12, 5)],
    ],
    3: [
        [(0, 0, 12, 7), (0, 7, 6, 5), (6, 7, 6, 5)],
        [(0, 0, 7, 12), (7, 0, 5, 6), (7, 6, 5, 6)],
    ],
    4: [
        [(0, 0, 7, 7), (7, 0, 5, 7), (0, 7, 5, 5), (5, 7, 7, 5)],
        [(0, 0, 5, 12), (5, 0, 7, 5), (5, 5, 3, 7), (8, 5, 4, 7)],
    ],
    5: [
        [(0, 0, 7, 7), (7, 0, 5, 4), (7, 4, 5, 3), (0, 7, 4, 5), (4, 7, 8, 5)],
        [(0, 0, 4, 6), (4, 0, 8, 6), (0, 6, 5, 6), (5, 6, 3, 6), (8, 6, 4, 6)],
    ],
    6: [
        [(0, 0, 5, 6), (5, 0, 4, 6), (9, 0, 3, 6),
         (0, 6, 3, 6), (3, 6, 4, 6), (7, 6, 5, 6)],
        [(0, 0, 6, 7), (6, 0, 6, 4), (6, 4, 3, 3), (9, 4, 3, 3),
         (0, 7, 6, 5), (6, 7, 6, 5)],
    ],
    7: [
        [(0, 0, 6, 7), (6, 0, 3, 4), (9, 0, 3, 4), (6, 4, 6, 3),
         (0, 7, 3, 5), (3, 7, 4, 5), (7, 7, 5, 5)],
        [(0, 0, 4, 5), (4, 0, 4, 5), (8, 0, 4, 5),
         (0, 5, 7, 4), (7, 5, 5, 4), (0, 9, 5, 3), (5, 9, 7, 3)],
    ],
    8: [
        [(0, 0, 4, 6), (4, 0, 5, 6), (9, 0, 3, 3), (9, 3, 3, 3),
         (0, 6, 3, 6), (3, 6, 3, 6), (6, 6, 3, 6), (9, 6, 3, 6)],
        [(0, 0, 3, 4), (3, 0, 3, 4), (6, 0, 6, 8), (0, 4, 6, 4),
         (0, 8, 3, 4), (3, 8, 3, 4), (6, 8, 3, 4), (9, 8, 3, 4)],
    ],
    9: [
        [(0, 0, 5, 5), (5, 0, 4, 5), (9, 0, 3, 5),
         (0, 5, 3, 4), (3, 5, 3, 4), (6, 5, 6, 4),
         (0, 9, 4, 3), (4, 9, 4, 3), (8, 9, 4, 3)],
        [(0, 0, 4, 4), (4, 0, 4, 4), (8, 0, 4, 4),
         (0, 4, 6, 5), (6, 4, 3, 5), (9, 4, 3, 5),
         (0, 9, 3, 3), (3, 9, 5, 3), (8, 9, 4, 3)],
    ],
}
MAX_PER_PAGE = max(BENTO)
GRID = 12


@dataclass
class CollagePhoto:
    path: Path
    caption: str = ""
    subcaption: str = ""
    #: Stable id for this photo in the owning job. The PDF pass never needs it;
    #: the viewer uses it to build a thumbnail URL.
    photo_id: str = ""
    #: True when ``path`` is an AI-enhanced render rather than the original
    #: frame, so the viewer fetches the same picture the PDF embedded.
    enhanced: bool = False
    #: The event this photo belongs to. Consecutive photos sharing a chapter
    #: become one section of the album, announced by a divider page.
    chapter: str = ""
    #: Normalised [x1, y1, x2, y2] face boxes (0..1) for this photo, from the
    #: identity clustering. Used to keep faces inside the crop.
    faces: Sequence[tuple[float, float, float, float]] = ()


@dataclass
class CastMember:
    """Someone the identity clustering found, for the cast page."""

    name: str
    path: Path
    #: Normalised [x1, y1, x2, y2] face box in ``path``, for the portrait crop.
    face: Optional[tuple[float, float, float, float]] = None
    #: Id of ``path`` in the owning job, so the viewer can fetch the same frame.
    photo_id: str = ""


@dataclass
class CollageSpec:
    title: str = "Lumina Album"
    subtitle: str = ""
    theme: str = DEFAULT_THEME
    photos: list[CollagePhoto] = field(default_factory=list)
    footer: str = "Curated by Lumina"
    stats: Sequence[tuple[str, str]] = ()
    #: When non-empty, the album opens with a page introducing these people.
    cast: Sequence[CastMember] = ()
    #: 小黑 appears on the divider, cast and closing pages. Off by default so
    #: existing albums are untouched.
    character: bool = False
    #: Seeds the character's outline, so one album's 小黑 is consistent and two
    #: albums' are not identical.
    character_seed: int = 0
    #: Which silhouette 小黑 wears — bean, cylinder, box, funnel or shadow.
    character_body: str = "bean"


# ---------------------------------------------------------------------------
# Layout plan
# ---------------------------------------------------------------------------
# Geometry is solved once, up front, and both renderers consume the result: the
# ReportLab pass below draws it to PDF, and ``plan_to_dict`` serialises it for
# the in-app flip-book. One source of truth is the only way the album you page
# through on screen stays the album that comes out of the printer.
#
# Plan coordinates run from the TOP-LEFT of the page, because that is what CSS
# wants. The PDF pass flips y at draw time.


@dataclass(frozen=True)
class PlacedTile:
    """One photo, placed on a page."""

    #: Index into ``CollageSpec.photos``.
    photo_index: int
    #: The number printed in the tile label, and used by the back index.
    number: int
    x: float
    top: float
    w: float
    #: Full slot height, including the caption band when there is one.
    h: float
    #: Height of the image itself; equal to ``h`` when the tile is unlabelled.
    photo_h: float

    @property
    def labelled(self) -> bool:
        return self.photo_h < self.h


@dataclass(frozen=True)
class PlacedCharacter:
    """Where 小黑 stands on a page, and what he is doing there."""

    pose: str
    x: float
    top: float
    w: float
    h: float
    seed: int
    facing: int = -1
    body: str = "bean"


@dataclass(frozen=True)
class PlacedPortrait:
    """One face on the cast page, cropped to a circle."""

    cast_index: int
    name: str
    x: float
    top: float
    size: float


@dataclass(frozen=True)
class PlannedPage:
    kind: str                       # "cover" | "bento" | "chapter" | "cast"
    number: int                     # 1-based among content pages; 0 on the cover
    tiles: tuple[PlacedTile, ...]
    title: str = ""
    subtitle: str = ""
    character: Optional[PlacedCharacter] = None
    portraits: tuple[PlacedPortrait, ...] = ()


@dataclass(frozen=True)
class AlbumPlan:
    spec: CollageSpec
    theme: Theme
    pages: tuple[PlannedPage, ...]

    @property
    def content_pages(self) -> int:
        return sum(1 for page in self.pages if page.kind != "cover")


def _chunk(photos: Sequence[CollagePhoto]) -> list[list[CollagePhoto]]:
    """Split into pages, avoiding a lonely single photo on the final page."""
    pages: list[list[CollagePhoto]] = []
    i, n = 0, len(photos)
    while i < n:
        remaining = n - i
        take = min(MAX_PER_PAGE, remaining)
        if remaining - take == 1 and take > 2:
            take -= 1
        pages.append(list(photos[i : i + take]))
        i += take
    return pages


def _chapters(photos: Sequence[CollagePhoto]) -> list[tuple[str, list[CollagePhoto]]]:
    """Split the album into consecutive runs sharing a chapter label.

    Runs, not a grouping: the photo order is the album's narrative, and
    reordering it to gather a label that recurs later would break the sequence
    the curation chose.
    """
    runs: list[tuple[str, list[CollagePhoto]]] = []
    for photo in photos:
        if runs and runs[-1][0] == photo.chapter:
            runs[-1][1].append(photo)
        else:
            runs.append((photo.chapter, [photo]))
    return runs


#: Poses used on the divider pages, cycled so a long album does not repeat one.
CHAPTER_POSES = ("carry", "hang", "point", "sweep")


def _plan_chapter(spec: CollageSpec, label: str, count: int,
                  number: int, index: int) -> PlannedPage:
    """A divider: the chapter's name, its size, and 小黑 doing the moving."""
    character = None
    if spec.character:
        height = PAGE_H * 0.38
        character = PlacedCharacter(
            pose=CHAPTER_POSES[index % len(CHAPTER_POSES)],
            body=spec.character_body,
            w=height * 1.25,
            h=height,
            x=PAGE_W - MARGIN - height * 1.25,
            top=PAGE_H - (MARGIN + 34) - height,
            seed=spec.character_seed + index * 17,
            facing=-1,
        )
    return PlannedPage(
        "chapter", number, (),
        title=label,
        subtitle=f"{count} photograph{'s' if count != 1 else ''}",
        character=character,
    )


def _plan_cast(spec: CollageSpec, number: int) -> PlannedPage:
    """The people in the album, introduced before the photographs start."""
    members = list(spec.cast)[:12]
    if not members:
        return PlannedPage("cast", number, ())

    character = None
    char_w = 0.0
    if spec.character:
        height = PAGE_H * 0.26
        char_w = height * 1.25
        character = PlacedCharacter(
            pose="tag", body=spec.character_body, w=char_w, h=height, x=MARGIN,
            top=PAGE_H * 0.40, seed=spec.character_seed + 101, facing=1,
        )

    per_row = min(len(members), 6)
    rows = math.ceil(len(members) / per_row)
    gap = 18.0
    left = MARGIN + (char_w + 26 if character else 0.0)
    available = PAGE_W - MARGIN - left
    size = min(
        (available - (per_row - 1) * gap) / per_row,
        (PAGE_H * 0.46 - (rows - 1) * (gap + 14)) / rows,
    )
    top0 = PAGE_H * 0.40 - (rows * size + (rows - 1) * (gap + 14)) / 2 + size * 0.25

    portraits: list[PlacedPortrait] = []
    for i, member in enumerate(members):
        row, col = divmod(i, per_row)
        in_row = min(per_row, len(members) - row * per_row)
        row_w = in_row * size + (in_row - 1) * gap
        x = left + (available - row_w) / 2 + col * (size + gap)
        portraits.append(PlacedPortrait(
            cast_index=i, name=member.name, x=x,
            top=top0 + row * (size + gap + 14), size=size,
        ))

    return PlannedPage(
        "cast", number, (),
        title="The cast",
        subtitle=f"{len(spec.cast)} {'person' if len(spec.cast) == 1 else 'people'}",
        character=character,
        portraits=tuple(portraits),
    )


def _plan_cover(spec: CollageSpec) -> PlannedPage:
    """The cover's preview band: up to three photos in a staggered strip."""
    previews = spec.photos[:3]
    if not previews:
        return PlannedPage("cover", 0, ())

    if len(previews) == 1:
        rects = [(0.0, 1.0)]
    elif len(previews) == 2:
        rects = [(0.0, 0.62), (0.62, 0.38)]
    else:
        rects = [(0.0, 0.52), (0.52, 0.26), (0.78, 0.22)]

    inner_w = PAGE_W - MARGIN * 2
    strip_h = PAGE_H * COVER_STRIP_FRACTION
    top = PAGE_H - COVER_STRIP_BOTTOM - strip_h

    tiles: list[PlacedTile] = []
    for i, (fx, fw) in enumerate(rects):
        x = MARGIN + fx * inner_w + (GUTTER / 2 if fx > 0 else 0.0)
        w = fw * inner_w - (GUTTER if fx > 0 else GUTTER / 2)
        if w > 1:
            tiles.append(PlacedTile(photo_index=i, number=i + 1, x=x, top=top,
                                    w=w, h=strip_h, photo_h=strip_h))
    return PlannedPage("cover", 0, tuple(tiles))


def plan_album(spec: CollageSpec) -> AlbumPlan:
    """Work out every page and every rectangle, without touching a pixel."""
    if not spec.photos:
        raise ValueError("A collage needs at least one photo.")

    theme = THEMES.get(spec.theme, THEMES[DEFAULT_THEME])
    pages: list[PlannedPage] = [_plan_cover(spec)]

    content_top = MARGIN + 24                       # measured from the page top
    content_h = PAGE_H - content_top - (MARGIN + 12)
    content_w = PAGE_W - MARGIN * 2
    cell_w = content_w / GRID
    cell_h = content_h / GRID

    runs = _chapters(spec.photos)
    # A divider only earns its page when there is more than one named chapter;
    # otherwise it is a title page for an album that already has one.
    named = [label for label, _ in runs if label]
    dividers = len(set(named)) > 1 and len(runs) > 1

    counter = 1        # the photo's number, and its index into spec.photos + 1
    folio = 0          # printed page number: every page after the cover has one
    bento_index = 0    # drives template alternation, so dividers do not skew it

    if spec.cast:
        folio += 1
        pages.append(_plan_cast(spec, folio))

    for chapter_index, (label, group) in enumerate(runs):
        if dividers and label:
            folio += 1
            pages.append(_plan_chapter(spec, label, len(group), folio, chapter_index))

        for batch in _chunk(group):
            folio += 1
            options = BENTO[len(batch)]
            slots = options[bento_index % len(options)]
            bento_index += 1
            order = _assign_slots(batch, slots, cell_w, cell_h)

            tiles: list[PlacedTile] = []
            for slot_index, (col, row, cspan, rspan) in enumerate(slots):
                index = order[slot_index]
                photo = batch[index]
                x = MARGIN + col * cell_w + GUTTER / 2
                w = cspan * cell_w - GUTTER
                top = content_top + row * cell_h + GUTTER / 2
                h_full = rspan * cell_h - GUTTER

                labelled = bool(photo.caption or photo.subcaption)
                photo_h = h_full - (CAPTION_H + CAPTION_GAP if labelled else 0.0)
                if w > 1 and photo_h > 1:
                    tiles.append(PlacedTile(
                        photo_index=counter - 1 + index, number=counter + index,
                        x=x, top=top, w=w, h=h_full, photo_h=photo_h,
                    ))

            pages.append(PlannedPage("bento", folio, tuple(tiles), title=label))
            counter += len(batch)

    return AlbumPlan(spec=spec, theme=theme, pages=tuple(pages))


def plan_to_dict(plan: AlbumPlan) -> dict:
    """Serialise a plan for the viewer. Lengths stay in PDF points; the client
    scales by (rendered width / page width), so one number drives the whole
    layout and nothing has to be re-derived on the other side."""
    spec, theme = plan.spec, plan.theme
    return {
        "title": spec.title,
        "subtitle": spec.subtitle,
        "footer": spec.footer,
        "stats": [{"value": value, "label": label} for value, label in spec.stats],
        "page": {
            "width": PAGE_W, "height": PAGE_H, "margin": MARGIN,
            "gutter": GUTTER, "cornerRadius": CORNER_RADIUS,
            "captionHeight": CAPTION_H, "captionGap": CAPTION_GAP,
            "coverStripBottom": COVER_STRIP_BOTTOM,
        },
        "theme": {
            "key": theme.key, "name": theme.name,
            "bgTop": theme.bg_top, "bgBottom": theme.bg_bottom,
            "ink": theme.ink, "muted": theme.muted, "accent": theme.accent,
            "frame": theme.frame, "grain": theme.grain,
            "serif": theme.display_serif, "dark": theme.dark,
            "shadowAlpha": theme.shadow_alpha, "flat": theme.flat,
        },
        "totalPages": plan.content_pages,
        "pages": [
            {
                "kind": page.kind,
                "number": page.number,
                "pageTitle": page.title,
                "pageSubtitle": page.subtitle,
                "character": None if page.character is None else {
                    "pose": page.character.pose,
                    "body": page.character.body,
                    "x": page.character.x, "top": page.character.top,
                    "w": page.character.w, "h": page.character.h,
                    "seed": page.character.seed, "facing": page.character.facing,
                },
                "portraits": [
                    {
                        "castIndex": portrait.cast_index,
                        "name": portrait.name,
                        "photoId": (spec.cast[portrait.cast_index].photo_id
                                    if portrait.cast_index < len(spec.cast) else ""),
                        "face": (list(spec.cast[portrait.cast_index].face or ())
                                 if portrait.cast_index < len(spec.cast) else []),
                        "x": portrait.x, "top": portrait.top, "size": portrait.size,
                    }
                    for portrait in page.portraits
                ],
                "tiles": [
                    {
                        "photoId": spec.photos[tile.photo_index].photo_id,
                        "enhanced": spec.photos[tile.photo_index].enhanced,
                        "number": tile.number,
                        "x": tile.x, "top": tile.top, "w": tile.w, "h": tile.h,
                        "photoH": tile.photo_h,
                        "caption": spec.photos[tile.photo_index].caption,
                        "subcaption": spec.photos[tile.photo_index].subcaption,
                    }
                    for tile in page.tiles
                ],
            }
            for page in plan.pages
        ],
    }


# ---------------------------------------------------------------------------
# Pillow helpers
# ---------------------------------------------------------------------------

def _gradient_background(theme: Theme, width: int, height: int) -> Image.Image:
    if theme.flat:
        return Image.new("RGB", (width, height), _rgb(theme.bg_top))

    top, bottom = _rgb(theme.bg_top), _rgb(theme.bg_bottom)
    base = Image.new("RGB", (1, height))
    px = base.load()
    for y in range(height):
        t = y / max(1, height - 1)
        t = t * t * (3 - 2 * t)  # smoothstep: no banding across a large page
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    img = base.resize((width, height), Image.BILINEAR)

    glow = Image.new("L", (width, height), 0)
    ImageDraw.Draw(glow).ellipse(
        [int(width * 0.04), int(-height * 0.45), int(width * 0.74), int(height * 0.48)],
        fill=54 if theme.dark else 36,
    )
    glow = glow.filter(ImageFilter.GaussianBlur(radius=max(width, height) * 0.12))
    tint = Image.new("RGB", (width, height), _rgb(theme.accent))
    img = Image.composite(Image.blend(img, tint, 0.15), img, glow)

    if theme.grain > 0:
        import random

        rnd = random.Random(0x11A)
        noise = Image.new("L", (max(1, width // 3), max(1, height // 3)))
        noise.putdata([rnd.randint(0, 255) for _ in range(noise.width * noise.height)])
        noise = noise.resize((width, height), Image.BILINEAR)
        img = Image.blend(img, Image.merge("RGB", (noise, noise, noise)),
                          0.032 * theme.grain)
    return img


def _best_offset(
    extent: int,
    window: int,
    spans: Sequence[tuple[float, float]],
    default_bias: float,
) -> int:
    """Pick a 1-D crop offset that keeps as many face spans whole as possible.

    A centre crop slices faces off the edges of group shots. Optimising x and y
    independently is an approximation, but the crop window has a fixed size in
    both axes, so it lands on the same answer as a 2-D search in every layout
    this produces - and it costs microseconds.
    """
    slack = extent - window
    if slack <= 0:
        return 0
    if not spans:
        return int(round(min(max((extent * default_bias) - window / 2, 0), slack)))

    def score(offset: float) -> float:
        total = 0.0
        for lo, hi in spans:
            size = max(hi - lo, 1e-6)
            fraction = max(0.0, min(hi, offset + window) - max(lo, offset)) / size
            if fraction >= 0.99:
                total += 1.0        # whole face kept
            elif fraction > 0.02:
                # A face sliced through the middle looks broken, while a face
                # left cleanly outside the frame just isn't in that shot. So
                # partial inclusion is penalised, worst at half in / half out.
                total -= 0.6 * (1.0 - abs(2.0 * fraction - 1.0))
        return total

    lo_all = min(lo for lo, _ in spans)
    hi_all = max(hi for _, hi in spans)
    candidates = {0.0, float(slack), (lo_all + hi_all) / 2 - window / 2}
    for lo, hi in spans:
        candidates.add((lo + hi) / 2 - window / 2)   # centre this face
        candidates.add(lo - 4)                        # flush its leading edge
        candidates.add(hi + 4 - window)               # flush its trailing edge

    best, best_score = 0.0, -1.0
    for raw in sorted(candidates):
        offset = min(max(raw, 0.0), float(slack))
        value = score(offset)
        # Tie-break toward the framing a photographer would choose.
        value -= 1e-4 * abs(offset - (slack * default_bias))
        if value > best_score:
            best, best_score = offset, value
    return int(round(best))


def _cover_crop(
    path: Path,
    box_w: float,
    box_h: float,
    faces: Sequence[tuple[float, float, float, float]] = (),
) -> Optional[Image.Image]:
    """Crop to the slot's aspect ratio, keeping faces whole, then size for DPI."""
    try:
        with Image.open(path) as src:
            img = ImageOps.exif_transpose(src).convert("RGB")
    except Exception:
        return None

    # Largest window of the slot's aspect ratio that fits inside the photo.
    target_ratio = max(box_w, 1e-6) / max(box_h, 1e-6)
    if img.width / img.height > target_ratio:
        crop_h = img.height
        crop_w = max(1, min(img.width, int(round(img.height * target_ratio))))
    else:
        crop_w = img.width
        crop_h = max(1, min(img.height, int(round(img.width / target_ratio))))

    x_spans = [(fx1 * img.width, fx2 * img.width)
               for fx1, _, fx2, _ in faces if fx2 > fx1]
    y_spans = [(fy1 * img.height, fy2 * img.height)
               for _, fy1, _, fy2 in faces if fy2 > fy1]
    # Faces sit above centre in most portraits, so bias upward when guessing.
    left = _best_offset(img.width, crop_w, x_spans, 0.5)
    top = _best_offset(img.height, crop_h, y_spans, 0.42)

    cropped = img.crop((left, top, left + crop_w, top + crop_h))

    target_w = max(1, int(box_w / 72.0 * TARGET_DPI))
    target_h = max(1, int(box_h / 72.0 * TARGET_DPI))
    # Never upscale past the source; shrink the target uniformly so the crop's
    # aspect ratio is unchanged.
    fit = min(1.0, cropped.width / target_w, cropped.height / target_h)
    if fit < 1.0:
        target_w = max(1, round(target_w * fit))
        target_h = max(1, round(target_h * fit))
    try:
        return cropped.resize((target_w, target_h), Image.LANCZOS)
    except Exception:
        return None


def _assign_slots(
    photos: Sequence[CollagePhoto],
    slots: Sequence[tuple[int, int, int, int]],
    cell_w: float,
    cell_h: float,
) -> list[int]:
    """Map each slot to the photo whose shape fits it best.

    Dropping a 16:9 group shot into a tall slot throws away a third of the frame
    however cleverly it is cropped, so match orientations first and let the
    face-aware crop handle what is left. Cost is the log-ratio distance between
    photo and slot aspect, which is symmetric for portrait and landscape.
    """
    import math

    aspects: list[float] = []
    for photo in photos:
        try:
            with Image.open(photo.path) as img:
                w, h = ImageOps.exif_transpose(img).size
            aspects.append(max(w, 1) / max(h, 1))
        except Exception:
            aspects.append(1.0)

    slot_aspects = [
        (cspan * cell_w - GUTTER) / max(rspan * cell_h - GUTTER, 1e-6)
        for _, _, cspan, rspan in slots
    ]
    cost = [[abs(math.log(max(a, 1e-6)) - math.log(max(sa, 1e-6)))
             for a in aspects] for sa in slot_aspects]

    try:
        from scipy.optimize import linear_sum_assignment

        _, order = linear_sum_assignment(cost)
        return [int(i) for i in order]
    except Exception:
        # Greedy fallback: claim the cheapest remaining pair each round.
        remaining = set(range(len(photos)))
        order = []
        for row in cost:
            pick = min(remaining, key=lambda i: row[i])
            remaining.discard(pick)
            order.append(pick)
        return order


def _rounded_mask(size: tuple[int, int], radius_px: int) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size[0] - 1, size[1] - 1], radius=max(0, radius_px), fill=255
    )
    return mask


def _jpeg_reader(img: Image.Image, quality: int = JPEG_QUALITY) -> ImageReader:
    """Wrap a PIL image as a JPEG stream so ReportLab embeds it verbatim."""
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=quality, optimize=True)
    buf.seek(0)
    return ImageReader(buf)


_BG_CACHE: dict[str, Image.Image] = {}


def _background_image(theme: Theme) -> Image.Image:
    cached = _BG_CACHE.get(theme.key)
    if cached is None:
        cached = _gradient_background(
            theme, int(PAGE_W / 72.0 * BG_DPI), int(PAGE_H / 72.0 * BG_DPI)
        )
        _BG_CACHE[theme.key] = cached
    return cached


# ---------------------------------------------------------------------------
# Type helpers
# ---------------------------------------------------------------------------

def _display_font(theme: Theme, bold: bool = False) -> str:
    if theme.display_serif:
        return "Times-Bold" if bold else "Times-Roman"
    return "Helvetica-Bold" if bold else "Helvetica"


def _fit(c: pdfcanvas.Canvas, text: str, font: str, size: float, max_w: float) -> str:
    """Truncate with an ellipsis so labels never overrun their column."""
    if not text or c.stringWidth(text, font, size) <= max_w:
        return text
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if c.stringWidth(text[:mid] + "…", font, size) <= max_w:
            lo = mid
        else:
            hi = mid - 1
    return text[:lo] + "…"


def _tracked(c: pdfcanvas.Canvas, text: str, x: float, y: float,
             font: str, size: float, tracking: float) -> None:
    """Letter-spaced text - ReportLab has no tracking, so step glyph by glyph."""
    c.setFont(font, size)
    cursor = x
    for ch in text:
        c.drawString(cursor, y, ch)
        cursor += c.stringWidth(ch, font, size) + tracking


def _tracked_width(c: pdfcanvas.Canvas, text: str, font: str,
                   size: float, tracking: float) -> float:
    if not text:
        return 0.0
    return c.stringWidth(text, font, size) + tracking * (len(text) - 1)


def _wrap(c: pdfcanvas.Canvas, text: str, font: str, size: float,
          max_w: float, max_lines: int) -> list[str]:
    lines, cur = [], ""
    for word in text.split():
        trial = f"{cur} {word}".strip()
        if c.stringWidth(trial, font, size) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = word
            if len(lines) == max_lines:
                return lines
    if cur and len(lines) < max_lines:
        lines.append(cur)
    return lines


# ---------------------------------------------------------------------------
# Drawing
# ---------------------------------------------------------------------------

def _draw_image(c: pdfcanvas.Canvas, reader: ImageReader,
                x: float, y: float, w: float, h: float) -> None:
    """Draw a photographic plate at full strength.

    ReportLab's fill alpha lives in the graphics state and applies to images as
    well as to text, so a label drawn at 0.75 leaves every image that follows it
    washed out toward the page colour until something resets it. Page chrome is
    drawn before the photographs, so without this every content page was being
    laid down at three-quarter opacity.
    """
    c.setFillAlpha(1.0)
    c.drawImage(reader, x, y, width=w, height=h, preserveAspectRatio=False)


def _draw_background(c: pdfcanvas.Canvas, theme: Theme) -> None:
    _draw_image(c, _jpeg_reader(_background_image(theme), 90), 0, 0, PAGE_W, PAGE_H)


def _draw_tile(c: pdfcanvas.Canvas, theme: Theme, photo: CollagePhoto,
               x: float, y: float, w: float, h: float) -> bool:
    """Draw one photo with rounded corners and a soft shadow - undarkened.

    Shadow, corners and photo are composited over a crop of the page background
    in Pillow, so a single opaque JPEG reaches the PDF.
    """
    img = _cover_crop(photo.path, w, h, photo.faces)
    if img is None:
        return False

    bleed = SHADOW_BLEED
    tile_x, tile_y = x - bleed, y - bleed
    tile_w, tile_h = w + bleed * 2, h + bleed * 2

    bg = _background_image(theme)
    px_per_pt = bg.width / PAGE_W
    left = int(round(tile_x * px_per_pt))
    top = int(round((PAGE_H - tile_y - tile_h) * px_per_pt))
    tile = bg.crop((left, top,
                    left + max(1, int(round(tile_w * px_per_pt))),
                    top + max(1, int(round(tile_h * px_per_pt))))).convert("RGB")

    scale = img.width / max(w, 1e-6)
    tile = tile.resize(
        (max(1, round(tile_w * scale)), max(1, round(tile_h * scale))), Image.LANCZOS
    )
    inset = round(bleed * scale)
    radius_px = max(0, round(theme.radius * scale))

    if theme.shadow_alpha > 0:
        drop = round(bleed * scale * 0.4)
        shadow = Image.new("L", tile.size, 0)
        ImageDraw.Draw(shadow).rounded_rectangle(
            [inset, inset + drop, inset + img.width - 1, inset + img.height - 1 + drop],
            radius=max(1, radius_px), fill=round(255 * theme.shadow_alpha),
        )
        shadow = shadow.filter(
            ImageFilter.GaussianBlur(radius=max(1.0, bleed * scale * 0.42))
        )
        tile = Image.composite(Image.new("RGB", tile.size, (0, 0, 0)), tile, shadow)

    tile.paste(img, (inset, inset),
               _rounded_mask(img.size, radius_px) if radius_px else None)

    _draw_image(c, _jpeg_reader(tile), tile_x, tile_y, tile_w, tile_h)

    c.setStrokeColor(_hex(theme.frame, 1.0 if theme.flat else 0.7))
    c.setLineWidth(theme.keyline)
    if theme.radius:
        c.roundRect(x, y, w, h, theme.radius, stroke=1, fill=0)
    else:
        c.rect(x, y, w, h, stroke=1, fill=0)
    return True


def _draw_tile_label(c: pdfcanvas.Canvas, theme: Theme, photo: CollagePhoto,
                     index: int, x: float, y: float, w: float) -> None:
    """Label beneath the tile - never drawn over the photograph."""
    if not photo.caption and not photo.subcaption:
        return

    num = f"{index:02d}"
    c.setFillColor(_hex(theme.accent, 0.9))
    c.setFont("Helvetica-Bold", 6.0)
    c.drawString(x + 1.0, y + CAPTION_H - 9.0, num)
    num_w = c.stringWidth(num, "Helvetica-Bold", 6.0) + 5.0

    avail = max(8.0, w - num_w - 2.0)
    if photo.caption:
        c.setFillColor(_hex(theme.ink, 0.92))
        c.setFont("Helvetica-Bold", 7.3)
        c.drawString(x + num_w, y + CAPTION_H - 9.0,
                     _fit(c, photo.caption, "Helvetica-Bold", 7.3, avail))
    if photo.subcaption:
        c.setFillColor(_hex(theme.muted, 0.95))
        c.setFont("Helvetica", 6.3)
        c.drawString(x + num_w, y + CAPTION_H - 17.0,
                     _fit(c, photo.subcaption, "Helvetica", 6.3, avail))


def _draw_cover(c: pdfcanvas.Canvas, theme: Theme, spec: CollageSpec,
                page: PlannedPage) -> None:
    """Editorial cover: masthead, display title, stat rail, bento preview strip."""
    _draw_background(c, theme)

    top = PAGE_H - MARGIN
    inner_w = PAGE_W - MARGIN * 2

    # --- masthead -------------------------------------------------------
    c.setFillColor(_hex(theme.accent))
    c.circle(MARGIN + 2.5, top - 17, 2.5, stroke=0, fill=1)
    _tracked(c, "LUMINA", MARGIN + 12, top - 19.5, "Helvetica-Bold", 7.6, 2.8)

    c.setFillColor(_hex(theme.muted, 0.85))
    right_label = "PHOTO ALBUM"
    w_right = _tracked_width(c, right_label, "Helvetica", 6.8, 1.9)
    _tracked(c, right_label, PAGE_W - MARGIN - w_right, top - 19.5, "Helvetica", 6.8, 1.9)

    c.setStrokeColor(_hex(theme.accent, 0.55))
    c.setLineWidth(0.8)
    c.line(MARGIN, top - 30, PAGE_W - MARGIN, top - 30)

    # --- display title --------------------------------------------------
    title_font = _display_font(theme)
    size = 46.0
    title_w = inner_w * 0.76
    while size > 20 and c.stringWidth(spec.title, title_font, size) > title_w:
        size -= 1.0
    lines = _wrap(c, spec.title, title_font, size, title_w, 2)

    y = top - 80
    c.setFillColor(_hex(theme.ink))
    for line in lines:
        c.setFont(title_font, size)
        c.drawString(MARGIN, y, line)
        y -= size * 1.02

    if spec.subtitle:
        c.setFillColor(_hex(theme.muted))
        _tracked(c, spec.subtitle.upper()[:74], MARGIN, y - 3, "Helvetica", 7.6, 1.9)
        y -= 14

    # --- bento preview strip + stat rail --------------------------------
    strip_h = PAGE_H * COVER_STRIP_FRACTION
    strip_y = COVER_STRIP_BOTTOM
    rail_y = strip_y + strip_h + 22

    if spec.stats:
        cursor = MARGIN
        bold = _display_font(theme, bold=True)
        for i, (value, label) in enumerate(spec.stats):
            if i:
                c.setStrokeColor(_hex(theme.frame, 0.9))
                c.setLineWidth(0.6)
                c.line(cursor - 13, rail_y - 4, cursor - 13, rail_y + 14)
            c.setFillColor(_hex(theme.ink, 0.95))
            c.setFont(bold, 14.5)
            c.drawString(cursor, rail_y + 4, value)
            vw = c.stringWidth(value, bold, 14.5)
            c.setFillColor(_hex(theme.muted))
            lw = _tracked_width(c, label.upper(), "Helvetica", 6.1, 1.6)
            _tracked(c, label.upper(), cursor, rail_y - 6, "Helvetica", 6.1, 1.6)
            cursor += max(vw, lw) + 26

    # Accent rule anchored right, aligned with the rail.
    c.setStrokeColor(_hex(theme.accent, 0.95))
    c.setLineWidth(2.2)
    c.line(PAGE_W - MARGIN - 70, rail_y + 1, PAGE_W - MARGIN, rail_y + 1)

    for tile in page.tiles:
        _draw_tile(c, theme, spec.photos[tile.photo_index],
                   tile.x, PAGE_H - tile.top - tile.h, tile.w, tile.h)

    # Corner marks - a small typographic detail that reads as "designed".
    c.setStrokeColor(_hex(theme.accent, 0.5))
    c.setLineWidth(0.7)
    m = 9.0
    c.line(MARGIN - m, MARGIN - m + 7, MARGIN - m, MARGIN - m)
    c.line(MARGIN - m, MARGIN - m, MARGIN - m + 7, MARGIN - m)
    c.line(PAGE_W - MARGIN + m, PAGE_H - MARGIN + m - 7,
           PAGE_W - MARGIN + m, PAGE_H - MARGIN + m)
    c.line(PAGE_W - MARGIN + m - 7, PAGE_H - MARGIN + m,
           PAGE_W - MARGIN + m, PAGE_H - MARGIN + m)


def _draw_page_chrome(c: pdfcanvas.Canvas, theme: Theme, spec: CollageSpec,
                      page_no: int, total_pages: int) -> None:
    top = PAGE_H - MARGIN
    c.setFillColor(_hex(theme.muted, 0.9))
    _tracked(c, spec.title.upper()[:56], MARGIN, top - 7, "Helvetica", 6.6, 1.6)

    label = f"{page_no:02d} / {total_pages:02d}"
    c.setFillColor(_hex(theme.accent))
    w = _tracked_width(c, label, "Helvetica-Bold", 6.6, 1.4)
    _tracked(c, label, PAGE_W - MARGIN - w, top - 7, "Helvetica-Bold", 6.6, 1.4)

    c.setStrokeColor(_hex(theme.frame, 0.85))
    c.setLineWidth(0.5)
    c.line(MARGIN, top - 15, PAGE_W - MARGIN, top - 15)

    if spec.footer:
        c.setFillColor(_hex(theme.muted, 0.75))
        _tracked(c, spec.footer.upper(), MARGIN, MARGIN * 0.44, "Helvetica", 5.8, 1.3)


def _plate(theme: Theme, x: float, top: float, w: float, h: float,
           px_w: int, px_h: int) -> Image.Image:
    """The page background under a rectangle, at the resolution asked for.

    Anything with an alpha channel has to be flattened before it reaches the
    PDF — ReportLab falls back to lossless Flate for transparency and the file
    size explodes — so transparent art is composited onto its own patch of
    background first.
    """
    bg = _background_image(theme)
    px_per_pt = bg.width / PAGE_W
    left = int(round(x * px_per_pt))
    upper = int(round(top * px_per_pt))
    patch = bg.crop((
        left, upper,
        left + max(1, int(round(w * px_per_pt))),
        upper + max(1, int(round(h * px_per_pt))),
    )).convert("RGB")
    return patch.resize((px_w, px_h), Image.LANCZOS)


def _draw_character(c: pdfcanvas.Canvas, theme: Theme,
                    placed: PlacedCharacter) -> None:
    """Draw 小黑, in the page's ink.

    On a dark theme a solid black character would simply disappear, so he is
    drawn in the theme's ink instead — pale on Midnight, near-black on Paper.
    The silhouette is what identifies him, not the colour.
    """
    import xiaohei

    px_w = max(1, int(placed.w / 72.0 * TARGET_DPI))
    px_h = max(1, int(placed.h / 72.0 * TARGET_DPI))
    try:
        # The eyes are holes in the body, so they take the page colour: white
        # on Paper, near-black on Midnight where 小黑 himself is pale.
        art = xiaohei.cached(placed.pose, placed.body, px_w, px_h,
                             placed.seed, _rgb(theme.ink), placed.facing,
                             _rgb(theme.bg_top))
    except Exception:
        return                      # a missing character never fails an export

    plate = _plate(theme, placed.x, placed.top, placed.w, placed.h, px_w, px_h)
    plate.paste(art, (0, 0), art)
    _draw_image(c, _jpeg_reader(plate), placed.x,
                PAGE_H - placed.top - placed.h, placed.w, placed.h)


def _portrait(path: Path, face: Optional[tuple[float, float, float, float]],
              px: int) -> Optional[Image.Image]:
    """A square crop centred on someone's face, for the cast page."""
    try:
        with Image.open(path) as src:
            img = ImageOps.exif_transpose(src).convert("RGB")
    except Exception:
        return None

    limit = min(img.width, img.height) / 2
    if face:
        x1, y1, x2, y2 = face
        cx = (x1 + x2) / 2 * img.width
        cy = (y1 + y2) / 2 * img.height
        # Room around the head, so the crop is a portrait and not a mugshot.
        half = max((x2 - x1) * img.width, (y2 - y1) * img.height) * 1.15
    else:
        cx, cy, half = img.width / 2, img.height * 0.42, limit
    half = max(8.0, min(half, limit))

    left = min(max(cx - half, 0.0), img.width - 2 * half)
    upper = min(max(cy - half, 0.0), img.height - 2 * half)
    crop = img.crop((round(left), round(upper),
                     round(left + 2 * half), round(upper + 2 * half)))
    return crop.resize((px, px), Image.LANCZOS)


def _draw_portrait(c: pdfcanvas.Canvas, theme: Theme, member: CastMember,
                   placed: PlacedPortrait) -> None:
    px = max(1, int(placed.size / 72.0 * TARGET_DPI))
    face = _portrait(member.path, member.face, px)
    y = PAGE_H - placed.top - placed.size

    if face is not None:
        plate = _plate(theme, placed.x, placed.top, placed.size, placed.size, px, px)
        mask = Image.new("L", (px * 4, px * 4), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, px * 4 - 1, px * 4 - 1], fill=255)
        plate.paste(face, (0, 0), mask.resize((px, px), Image.LANCZOS))
        _draw_image(c, _jpeg_reader(plate), placed.x, y, placed.size, placed.size)

    c.setStrokeColor(_hex(theme.frame, 1.0 if theme.flat else 0.8))
    c.setLineWidth(theme.keyline)
    c.circle(placed.x + placed.size / 2, y + placed.size / 2, placed.size / 2,
             stroke=1, fill=0)

    name = _fit(c, placed.name, "Helvetica-Bold", 7.4, placed.size + 12)
    c.setFillColor(_hex(theme.ink, 0.92))
    c.setFont("Helvetica-Bold", 7.4)
    c.drawCentredString(placed.x + placed.size / 2, y - 13, name)


def _draw_display_heading(c: pdfcanvas.Canvas, theme: Theme, title: str,
                          subtitle: str, top: float, measure: float) -> float:
    """A chapter or section heading, set in the theme's display face."""
    font = _display_font(theme)
    size = 38.0
    while size > 18 and c.stringWidth(title, font, size) > measure:
        size -= 1.0

    y = PAGE_H - top
    c.setFillColor(_hex(theme.ink))
    for line in _wrap(c, title, font, size, measure, 3):
        c.setFont(font, size)
        c.drawString(MARGIN, y, line)
        y -= size * 1.04

    c.setStrokeColor(_hex(theme.accent, 0.95))
    c.setLineWidth(2.0)
    c.line(MARGIN, y - 4, MARGIN + 54, y - 4)

    if subtitle:
        c.setFillColor(_hex(theme.muted))
        _tracked(c, subtitle.upper(), MARGIN, y - 21, "Helvetica", 7.0, 1.8)
    return y


def _draw_chapter(c: pdfcanvas.Canvas, theme: Theme, spec: CollageSpec,
                  page: PlannedPage, total: int) -> None:
    """A divider. Mostly empty, which is the point — it is a breath between
    two events, and 小黑 is the one carrying the album across the gap."""
    _draw_background(c, theme)
    _draw_page_chrome(c, theme, spec, page.number, total)

    if page.character:
        _draw_character(c, theme, page.character)

    measure = (PAGE_W - MARGIN * 2) * (0.48 if page.character else 0.76)
    _draw_display_heading(c, theme, page.title, page.subtitle,
                          top=PAGE_H * 0.42, measure=measure)


def _draw_cast(c: pdfcanvas.Canvas, theme: Theme, spec: CollageSpec,
               page: PlannedPage, total: int) -> None:
    """Who is in this album, before any of them turn up in a photograph."""
    _draw_background(c, theme)
    _draw_page_chrome(c, theme, spec, page.number, total)

    _draw_display_heading(c, theme, page.title, page.subtitle,
                          top=MARGIN + 74, measure=(PAGE_W - MARGIN * 2) * 0.6)

    if page.character:
        _draw_character(c, theme, page.character)

    for portrait in page.portraits:
        if portrait.cast_index < len(spec.cast):
            _draw_portrait(c, theme, spec.cast[portrait.cast_index], portrait)


def build_collage_pdf(spec: CollageSpec) -> bytes:
    """Render the album and return the PDF bytes."""
    plan = plan_album(spec)
    theme = plan.theme
    total = plan.content_pages

    buf = io.BytesIO()
    c = pdfcanvas.Canvas(buf, pagesize=(PAGE_W, PAGE_H))
    c.setTitle(spec.title)
    c.setAuthor("Lumina")
    c.setSubject(spec.subtitle or "Curated photo album")

    for page in plan.pages:
        if page.kind == "cover":
            _draw_cover(c, theme, spec, page)
        elif page.kind == "chapter":
            _draw_chapter(c, theme, spec, page, total)
        elif page.kind == "cast":
            _draw_cast(c, theme, spec, page, total)
        else:
            _draw_background(c, theme)
            _draw_page_chrome(c, theme, spec, page.number, total)
            for tile in page.tiles:
                photo = spec.photos[tile.photo_index]
                _draw_tile(c, theme, photo, tile.x,
                           PAGE_H - tile.top - tile.photo_h, tile.w, tile.photo_h)
                if tile.labelled:
                    _draw_tile_label(c, theme, photo, tile.number,
                                     tile.x, PAGE_H - tile.top - tile.h, tile.w)
        c.showPage()

    c.save()
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Text model helpers (optional, never fatal)
# ---------------------------------------------------------------------------

def caption_photos(paths: Sequence[Path], context: str = "") -> list[str]:
    """Ask the text model for a short title per photo. Returns [] on any failure."""
    import openrouter

    if not openrouter.is_configured() or not paths:
        return []
    try:
        return openrouter.describe_images([p.read_bytes() for p in paths], context=context)
    except Exception:
        return []


def suggest_title(
    photo_count: int, event_labels: Sequence[str], people: Sequence[str]
) -> tuple[str, str]:
    """Ask the text model for an album title; fall back to a sensible default."""
    import openrouter

    events = ", ".join(dict.fromkeys(l for l in event_labels if l)) or "an event"
    names = ", ".join(dict.fromkeys(p for p in people if p))

    default_title = (list(dict.fromkeys(l for l in event_labels if l)) or ["Lumina Album"])[0]
    default_sub = f"{photo_count} photo{'s' if photo_count != 1 else ''}"

    if not openrouter.is_configured():
        return default_title, default_sub

    try:
        raw = openrouter.complete_text(
            f"Photo album of {photo_count} photos. Scenes: {events}."
            + (f" People present: {names}." if names else "")
            + "\n\nWrite a title and a subtitle for this album."
            " The title is at most 4 words, evocative but not flowery, no quotes."
            " The subtitle is at most 8 words, lowercase except names."
            ' Reply as exactly two lines: "TITLE: ..." then "SUBTITLE: ...".',
            system="You name photo albums. Be concrete and warm. Never invent"
                   " details you were not told, such as places, dates or occasions.",
            max_tokens=120,
        )
    except Exception:
        return default_title, default_sub

    title, subtitle = default_title, default_sub
    for line in raw.splitlines():
        low = line.strip()
        if low.upper().startswith("TITLE:"):
            title = low.split(":", 1)[1].strip().strip('"') or title
        elif low.upper().startswith("SUBTITLE:"):
            subtitle = low.split(":", 1)[1].strip().strip('"') or subtitle
    return title[:70], subtitle[:90]
