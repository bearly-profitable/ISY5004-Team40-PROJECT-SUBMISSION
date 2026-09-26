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
import json
import math
import random
from dataclasses import dataclass, field, replace
from functools import lru_cache
from pathlib import Path
from typing import Optional, Sequence

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps
from reportlab.lib.colors import Color
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as pdfcanvas

import mascot

ASSETS = Path(__file__).resolve().parent / "assets"


def _register_fonts() -> tuple[str, str, str]:
    """Lumina's own type: Fraunces for display, Nunito for text (both SIL OFL,
    in assets/fonts). Falls back to the PDF core fonts if they are missing."""
    fonts = {"LumiDisplay": "Fraunces-SemiBold.ttf", "LumiBody": "Nunito-Regular.ttf",
             "LumiBodyBold": "Nunito-ExtraBold.ttf"}
    try:
        for name, file in fonts.items():
            if name not in pdfmetrics.getRegisteredFontNames():
                pdfmetrics.registerFont(TTFont(name, str(ASSETS / "fonts" / file)))
        return "LumiDisplay", "LumiBody", "LumiBodyBold"
    except Exception:
        return "Times-Roman", BODY, BODY_BOLD


DISPLAY, BODY, BODY_BOLD = _register_fonts()

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
    #: corners — a rounded card with a shadow is web furniture, not print.
    flat: bool = False
    #: Lumi's own look: photos printed on white rounded cards, pastel blobs in
    #: the background, sparkles in the open space, plum-tinted shadows.
    soft: bool = False

    @property
    def shadow_alpha(self) -> float:
        if self.flat:
            return 0.0
        return 0.40 if self.dark else 0.16

    @property
    def radius(self) -> float:
        if self.flat:
            return 0.0
        return 14.0 if self.soft else CORNER_RADIUS

    @property
    def mat(self) -> float:
        """Width of the white card a photo is printed on (0: no card)."""
        return 4.5 if self.soft else 0.0

    @property
    def shadow_rgb(self) -> tuple[int, int, int]:
        return (86, 52, 110) if self.soft else (0, 0, 0)

    @property
    def keyline(self) -> float:
        """Flat themes carry the tile edge with a hairline instead of a shadow."""
        return 0.9 if self.flat else 0.5


THEMES: dict[str, Theme] = {
    # Lumi's palette: cream fading to lavender, rose accents, plum ink.
    "lumi": Theme(
        key="lumi", name="Lumi", bg_top="#fdf6f3", bg_bottom="#efe6f7",
        ink="#3a2d4d", muted="#8e7ea3", accent="#d66f86", frame="#ecdff1",
        grain=0.06, display_serif=True, dark=False, soft=True,
    ),
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
    # Pure white, hairline rules, and an orange accent kept for annotation.
    "paper": Theme(
        key="paper", name="Paper", bg_top="#ffffff", bg_bottom="#ffffff",
        ink="#141414", muted="#9a9a9a", accent="#e2542c", frame="#141414",
        grain=0.0, display_serif=False, dark=False, flat=True,
    ),
}
DEFAULT_THEME = "lumi"


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
#: Height of the Lumi that sits in the footer corner of a page of photos. The
#: footer band is MARGIN + 12 tall; this fills it without touching the grid.
STICKER_H = MARGIN + 8


@dataclass
class CollagePhoto:
    path: Path
    caption: str = ""
    subcaption: str = ""
    #: Stable id for this photo in the owning job.
    photo_id: str = ""
    #: True when ``path`` is an AI-enhanced render rather than the original.
    enhanced: bool = False
    #: The event this photo belongs to. Consecutive photos sharing a chapter
    #: become one section of the album, announced by a divider page.
    chapter: str = ""
    #: Normalised [x1, y1, x2, y2] face boxes (0..1) for this photo, from the
    #: identity clustering. Used to keep faces inside the crop.
    faces: Sequence[tuple[float, float, float, float]] = ()
    #: What the photo shows, as one of CLIP's zero-shot event labels ("Beach",
    #: "Birthday", ...). Picks Lumi's pose on the page the photo lands on.
    scene: str = ""


@dataclass
class CastMember:
    """Someone the identity clustering found, for the cast page."""

    name: str
    path: Path
    #: Normalised [x1, y1, x2, y2] face box in ``path``, for the portrait crop.
    face: Optional[tuple[float, float, float, float]] = None
    #: Id of ``path`` in the owning job.
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
    #: Lumi appears on the divider and cast pages, and in the corner of every
    #: page of photos. Off by default so existing albums are untouched.
    character: bool = False
    #: Lumi's colourway — a key of ``mascot.OUTFITS``.
    character_outfit: str = "classic"


# ---------------------------------------------------------------------------
# Layout plan
# ---------------------------------------------------------------------------
# Geometry is solved once, up front, then the ReportLab pass below draws it.
# Plan coordinates run from the TOP-LEFT of the page; the PDF pass flips y at
# draw time.


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

    #: A Lumi frame pose (see mascot.FRAME_POSES) the photo is held in, or "".
    frame: str = ""
    #: Printed as a tilted polaroid, at this angle in degrees; None if flat.
    polaroid: Optional[float] = None

    @property
    def labelled(self) -> bool:
        return self.photo_h < self.h


@dataclass(frozen=True)
class PlacedCharacter:
    """Where Lumi stands on a page, and what Lumi is doing there."""

    pose: str
    x: float
    top: float
    w: float
    h: float
    #: 1 as drawn; -1 mirrored, so Lumi can face into the page.
    facing: int = 1
    outfit: str = "classic"


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
    kind: str                       # "cover" | "bento" | "chapter" | "cast" | "closing"
    number: int                     # 1-based among content pages; 0 on the cover
    tiles: tuple[PlacedTile, ...]
    title: str = ""
    subtitle: str = ""
    character: Optional[PlacedCharacter] = None
    portraits: tuple[PlacedPortrait, ...] = ()
    #: A photo shown as art on a divider (not one of the album's numbered
    #: tiles): the chapter's opening shot, as a polaroid Lumi leans on.
    feature: Optional[PlacedTile] = None


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


def _plan_chapter(spec: CollageSpec, label: str, group: Sequence[CollagePhoto],
                  number: int, index: int, first_photo: int) -> PlannedPage:
    """A divider: the chapter's name and size, and Lumi dressed for the scene,
    leaning on a polaroid of the chapter's opening photo."""
    count = len(group)
    character = feature = None
    if spec.character:
        # The chapter's own label first; failing that, what its photos show.
        pose = (mascot.pose_for_scene(label)
                or mascot.pose_for_page((p.scene for p in group), index))
        pw, ph = 236.0, 276.0
        px = PAGE_W * 0.62 - pw / 2
        ptop = (PAGE_H - ph) / 2 - 6
        feature = PlacedTile(photo_index=first_photo, number=0, x=px, top=ptop,
                             w=pw, h=ph, photo_h=ph,
                             polaroid=-5.0 if index % 2 else 4.0)
        height = PAGE_H * 0.44
        character = PlacedCharacter(
            pose=pose,
            outfit=spec.character_outfit,
            w=height,
            h=height,
            x=min(px + pw - height * 0.28, PAGE_W - MARGIN - height),
            top=PAGE_H - (MARGIN + 14) - height,
            facing=-1,
        )
    return PlannedPage(
        "chapter", number, (),
        title=label,
        subtitle=f"{count} photograph{'s' if count != 1 else ''}",
        character=character,
        feature=feature,
    )


def _plan_closing(spec: CollageSpec, number: int) -> PlannedPage:
    """The last page: Lumi hugging the album goodbye."""
    height = PAGE_H * 0.6
    return PlannedPage(
        "closing", number, (),
        title="That’s a wrap!",
        subtitle=f"{len(spec.photos)} photograph{'s' if len(spec.photos) != 1 else ''}, "
                 "curated by Lumi",
        character=PlacedCharacter(
            pose="hug", outfit=spec.character_outfit, w=height, h=height,
            x=PAGE_W - MARGIN - height, top=(PAGE_H - height) / 2 + 10, facing=1,
        ),
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
            pose="tag", outfit=spec.character_outfit, w=char_w, h=height, x=MARGIN,
            top=PAGE_H * 0.40, facing=1,
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


def _plan_lumi_cover(spec: CollageSpec) -> PlannedPage:
    """Lumi's cover: the first photo in Lumi's big hug on the right, and two
    more as tilted polaroids beneath the title."""
    tiles = []
    box_x, box_top = PAGE_W * 0.5, MARGIN * 0.55
    box_w, box_h = PAGE_W - box_x - MARGIN * 0.45, PAGE_H - MARGIN * 1.1
    pose = "bighug" if "bighug" in mascot.frame_poses() else mascot.pick_frame(box_w, box_h)
    if pose:
        tiles.append(PlacedTile(photo_index=0, number=1, x=box_x, top=box_top,
                                w=box_w, h=box_h, photo_h=box_h, frame=pose))
    for i, (x, angle) in enumerate(((MARGIN + 4, -6.0), (MARGIN + 132, 5.0)), start=1):
        if i < len(spec.photos):
            tiles.append(PlacedTile(photo_index=i, number=i + 1, x=x,
                                    top=PAGE_H - MARGIN - 162 - (8 if i == 2 else 0),
                                    w=118, h=140, photo_h=140, polaroid=angle))
    return PlannedPage("cover", 0, tuple(tiles))


def _plan_cover(spec: CollageSpec) -> PlannedPage:
    """The cover's preview band: up to three photos in a staggered strip."""
    if spec.character and mascot.frame_poses():
        return _plan_lumi_cover(spec)
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
    last_pose = None   # Lumi's pose on the previous page of photos
    last_frame = None  # and the frame Lumi held its hero photo in

    if spec.cast:
        folio += 1
        pages.append(_plan_cast(spec, folio))

    for chapter_index, (label, group) in enumerate(runs):
        if dividers and label:
            folio += 1
            pages.append(_plan_chapter(spec, label, group, folio, chapter_index,
                                       counter - 1))

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

            if spec.character and tiles:
                # The page's biggest photo is held by Lumi, in whichever frame
                # shows it largest for that slot's shape.
                hero = max(range(len(tiles)), key=lambda t: tiles[t].w * tiles[t].photo_h)
                frame = mascot.pick_frame(tiles[hero].w, tiles[hero].photo_h, last_frame)
                if frame:
                    tiles[hero] = replace(tiles[hero], frame=frame)
                    last_frame = frame

            character = None
            if spec.character:
                # A small Lumi in the footer's empty right-hand corner, dressed
                # for what this page's photos show.
                pose = mascot.pose_for_page(
                    [p.scene for p in batch], bento_index,
                    fallback=label, avoid=last_pose)
                last_pose = pose
                character = PlacedCharacter(
                    pose=pose, outfit=spec.character_outfit,
                    x=PAGE_W - MARGIN - STICKER_H, top=PAGE_H - STICKER_H - 4,
                    w=STICKER_H, h=STICKER_H, facing=-1,
                )
            pages.append(PlannedPage("bento", folio, tuple(tiles), title=label,
                                     character=character))
            counter += len(batch)

    if spec.character:
        folio += 1
        pages.append(_plan_closing(spec, folio))

    return AlbumPlan(spec=spec, theme=theme, pages=tuple(pages))


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

    if theme.soft:
        # Lumi's colours drifting in from the corners: hood, body, and blush.
        for colour, box, strength in (
            ("#c9b8ee", (-0.18, -0.35, 0.34, 0.45), 120),
            ("#f7c6d0", (0.72, 0.55, 1.2, 1.35), 120),
            ("#fbd6bd", (0.55, -0.4, 1.05, 0.25), 90),
        ):
            blob = Image.new("L", (width, height), 0)
            ImageDraw.Draw(blob).ellipse([int(box[0] * width), int(box[1] * height),
                                          int(box[2] * width), int(box[3] * height)],
                                         fill=strength)
            blob = blob.filter(ImageFilter.GaussianBlur(radius=max(width, height) * 0.08))
            img = Image.composite(Image.new("RGB", (width, height), _rgb(colour)), img, blob)

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
        return DISPLAY
    return BODY_BOLD


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
    mat = theme.mat
    img = _cover_crop(photo.path, w - mat * 2, h - mat * 2, photo.faces)
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

    scale = img.width / max(w - mat * 2, 1e-6)
    tile = tile.resize(
        (max(1, round(tile_w * scale)), max(1, round(tile_h * scale))), Image.LANCZOS
    )
    inset = round(bleed * scale)
    radius_px = max(0, round(theme.radius * scale))
    mat_px = round(mat * scale)
    card_w, card_h = img.width + mat_px * 2, img.height + mat_px * 2

    if theme.shadow_alpha > 0:
        drop = round(bleed * scale * 0.4)
        shadow = Image.new("L", tile.size, 0)
        ImageDraw.Draw(shadow).rounded_rectangle(
            [inset, inset + drop, inset + card_w - 1, inset + card_h - 1 + drop],
            radius=max(1, radius_px), fill=round(255 * theme.shadow_alpha),
        )
        shadow = shadow.filter(
            ImageFilter.GaussianBlur(radius=max(1.0, bleed * scale * 0.42))
        )
        tile = Image.composite(Image.new("RGB", tile.size, theme.shadow_rgb), tile, shadow)

    if mat_px:
        # The Lumi theme prints each photo on a white rounded card.
        tile.paste(Image.new("RGB", (card_w, card_h), (255, 253, 251)), (inset, inset),
                   _rounded_mask((card_w, card_h), radius_px))
        radius_px = max(0, radius_px - mat_px)
    tile.paste(img, (inset + mat_px, inset + mat_px),
               _rounded_mask(img.size, radius_px) if radius_px else None)

    _draw_image(c, _jpeg_reader(tile), tile_x, tile_y, tile_w, tile_h)

    if not theme.soft:
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
    c.setFont(BODY_BOLD, 6.0)
    c.drawString(x + 1.0, y + CAPTION_H - 9.0, num)
    num_w = c.stringWidth(num, BODY_BOLD, 6.0) + 5.0

    avail = max(8.0, w - num_w - 2.0)
    if photo.caption:
        c.setFillColor(_hex(theme.ink, 0.92))
        c.setFont(BODY_BOLD, 7.3)
        c.drawString(x + num_w, y + CAPTION_H - 9.0,
                     _fit(c, photo.caption, BODY_BOLD, 7.3, avail))
    if photo.subcaption:
        c.setFillColor(_hex(theme.muted, 0.95))
        c.setFont(BODY, 6.3)
        c.drawString(x + num_w, y + CAPTION_H - 17.0,
                     _fit(c, photo.subcaption, BODY, 6.3, avail))


def _draw_cover(c: pdfcanvas.Canvas, theme: Theme, spec: CollageSpec,
                page: PlannedPage) -> None:
    """Editorial cover: masthead, display title, stat rail, bento preview strip."""
    _draw_background(c, theme)

    top = PAGE_H - MARGIN
    inner_w = PAGE_W - MARGIN * 2

    # --- masthead -------------------------------------------------------
    c.setFillColor(_hex(theme.accent))
    c.circle(MARGIN + 2.5, top - 17, 2.5, stroke=0, fill=1)
    _tracked(c, "LUMINA", MARGIN + 12, top - 19.5, BODY_BOLD, 7.6, 2.8)

    c.setFillColor(_hex(theme.muted, 0.85))
    right_label = "PHOTO ALBUM"
    w_right = _tracked_width(c, right_label, BODY, 6.8, 1.9)
    _tracked(c, right_label, PAGE_W - MARGIN - w_right, top - 19.5, BODY, 6.8, 1.9)

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
        _tracked(c, spec.subtitle.upper()[:74], MARGIN, y - 3, BODY, 7.6, 1.9)
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
            lw = _tracked_width(c, label.upper(), BODY, 6.1, 1.6)
            _tracked(c, label.upper(), cursor, rail_y - 6, BODY, 6.1, 1.6)
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


# ---------------------------------------------------------------------------
# Lumi's art: composites, frames, polaroids and sparkles
# ---------------------------------------------------------------------------
# Everything with transparency (Lumi, a tilted polaroid, a soft shadow) is
# layered in Pillow over its own patch of page background, then reaches the
# PDF as one opaque JPEG, like every other image here.

def _px(points: float) -> int:
    return max(1, int(round(points / 72.0 * TARGET_DPI)))


def _pt(pixels: float) -> float:
    return pixels * 72.0 / TARGET_DPI


def _paste(canvas: Image.Image, img: Image.Image, ox: int, oy: int) -> None:
    """alpha_composite that tolerates layers hanging off the canvas edge."""
    x0, y0 = max(0, ox), max(0, oy)
    x1, y1 = min(canvas.width, ox + img.width), min(canvas.height, oy + img.height)
    if x1 > x0 and y1 > y0:
        canvas.alpha_composite(img.crop((x0 - ox, y0 - oy, x1 - ox, y1 - oy)), dest=(x0, y0))


def _shadow(theme: Theme, img: Image.Image) -> Optional[tuple[Image.Image, int]]:
    """A soft shadow in the layer's own shape, as (layer, padding)."""
    if theme.shadow_alpha <= 0:
        return None
    blur = _px(5.0)
    pad = blur * 3
    strength = min(1.0, theme.shadow_alpha * 1.8)
    alpha = img.getchannel("A").point(lambda v: int(v * strength))
    big = Image.new("L", (img.width + pad * 2, img.height + pad * 2), 0)
    big.paste(alpha, (pad, pad))
    layer = Image.new("RGBA", big.size, theme.shadow_rgb + (0,))
    layer.putalpha(big.filter(ImageFilter.GaussianBlur(blur)))
    return layer, pad


def _compose(c: pdfcanvas.Canvas, theme: Theme,
             rect: tuple[float, float, float, float],
             layers: Sequence[tuple[Image.Image, float, float, bool]]) -> None:
    """Draw `layers` of (image, x, top, casts a shadow) over the page, clipped
    to `rect` (x, top, w, h in points from the top-left)."""
    x, top, w, h = rect
    canvas = _plate(theme, x, top, w, h, _px(w), _px(h)).convert("RGBA")
    for img, lx, ltop, casts in layers:
        ox = round((lx - x) / 72.0 * TARGET_DPI)
        oy = round((ltop - top) / 72.0 * TARGET_DPI)
        shadow = _shadow(theme, img) if casts else None
        if shadow:
            layer, pad = shadow
            _paste(canvas, layer, ox - pad, oy - pad + _px(3.0))
        _paste(canvas, img, ox, oy)
    _draw_image(c, _jpeg_reader(canvas), x, PAGE_H - top - h, w, h)


def _frame_layer(theme: Theme, photo: CollagePhoto, pose: str, box_w: float, box_h: float,
                 outfit: str) -> Optional[tuple[Image.Image, float, float]]:
    """The photo held in a Lumi frame, as (RGBA, drawn width, drawn height)
    fitted inside a box. Lumi is drawn over the photo, paws and all."""
    meta = mascot.frame_meta().get(pose)
    if not meta:
        return None
    scale, dw, dh = mascot.frame_fit(pose, box_w, box_h)
    x0, y0, x1, y1 = meta["window"]
    out_w, out_h = _px(dw), _px(dh)
    k = out_w / meta["size"][0]
    # The sprite's card edge was cleared a few pixels wide; grow into it.
    grow = max(1, round(5 * k))
    win = (round(x0 * k) - grow, round(y0 * k) - grow,
           round(x1 * k) + grow, round(y1 * k) + grow)
    window = Image.new("L", (out_w, out_h), 0)
    ImageDraw.Draw(window).polygon([(px * k, py * k) for px, py in meta["polygon"]], fill=255)
    window = window.filter(ImageFilter.MaxFilter(grow * 2 + 1))

    # On the Lumi theme the photo is printed on a white rounded card, like
    # every other photo in the album; Lumi holds the card.
    mat = _px(theme.mat) if theme.mat else 0
    card_w, card_h = win[2] - win[0], win[3] - win[1]
    img = _cover_crop(photo.path, _pt(card_w - mat * 2), _pt(card_h - mat * 2), photo.faces)
    if img is None:
        return None
    img = img.resize((card_w - mat * 2, card_h - mat * 2), Image.LANCZOS)
    card = Image.new("RGBA", (card_w, card_h), (255, 253, 251, 255) if mat else (0, 0, 0, 0))
    radius = _px(theme.radius) if theme.radius else 0
    card.paste(img, (mat, mat), _rounded_mask(img.size, max(0, radius - mat)) if radius else None)
    if radius:
        card.putalpha(ImageChops.multiply(card.getchannel("A"),
                                          _rounded_mask(card.size, radius)))
    photo_layer = Image.new("RGBA", (out_w, out_h), (0, 0, 0, 0))
    photo_layer.paste(card, win[:2])
    layer = Image.new("RGBA", (out_w, out_h), (0, 0, 0, 0))
    layer.paste(photo_layer, (0, 0), ImageChops.multiply(window, photo_layer.getchannel("A")))
    sprite = mascot.frame_sprite(pose).resize((out_w, out_h), Image.LANCZOS)
    layer.alpha_composite(mascot._recolour(sprite, outfit))
    return layer, dw, dh


def _draw_framed(c: pdfcanvas.Canvas, theme: Theme, spec: CollageSpec,
                 tile: PlacedTile) -> bool:
    """A photo held by Lumi, centred in its slot."""
    photo = spec.photos[tile.photo_index]
    made = _frame_layer(theme, photo, tile.frame, tile.w, tile.photo_h, spec.character_outfit)
    if made is None:
        return False
    layer, dw, dh = made
    lx = tile.x + (tile.w - dw) / 2
    ltop = tile.top + (tile.photo_h - dh) / 2
    bleed = SHADOW_BLEED
    _compose(c, theme, (tile.x - bleed, tile.top - bleed, tile.w + bleed * 2,
                        tile.photo_h + bleed * 2), [(layer, lx, ltop, True)])
    return True


def _polaroid_layer(theme: Theme, photo: CollagePhoto, w: float, h: float,
                    angle: float) -> Optional[Image.Image]:
    """A white instant print with a strip of washi tape, tilted by `angle`."""
    W, H = _px(w), _px(h)
    side, bottom = round(W * 0.07), round(H * 0.19)
    img = _cover_crop(photo.path, _pt(W - side * 2), _pt(H - side - bottom), photo.faces)
    if img is None:
        return None
    tape_h = round(H * 0.09)
    card = Image.new("RGBA", (W, H + tape_h), (0, 0, 0, 0))
    body = Image.new("RGBA", (W, H), (255, 253, 251, 255))
    body.paste(img.resize((W - side * 2, H - side - bottom), Image.LANCZOS), (side, side))
    body.putalpha(_rounded_mask((W, H), round(W * 0.02)))
    card.alpha_composite(body, dest=(0, tape_h // 2))
    # Washi tape: translucent, in the theme's accent, slightly askew.
    tape = Image.new("RGBA", (round(W * 0.42), tape_h), _rgb(theme.accent) + (150,))
    tape = tape.rotate(-3, resample=Image.BICUBIC, expand=True)
    card.alpha_composite(tape, dest=((W - tape.width) // 2, 0))
    return card.rotate(angle, resample=Image.BICUBIC, expand=True)


def _centred_on(tile: PlacedTile, img: Image.Image) -> tuple[float, float]:
    """Top-left, in points, that keeps a (rotated) image centred on its tile."""
    return tile.x + tile.w / 2 - _pt(img.width) / 2, tile.top + tile.h / 2 - _pt(img.height) / 2


def _lumi_layer(placed: PlacedCharacter) -> Image.Image:
    return mascot.render(placed.pose, _px(placed.w), _px(placed.h), placed.outfit,
                         placed.facing)


def _layers_rect(layers: Sequence[tuple[Image.Image, float, float, bool]],
                 pad: float = 14.0) -> tuple[float, float, float, float]:
    """The rectangle (x, top, w, h) that holds every layer and its shadow."""
    x0 = min(lx for _, lx, _, _ in layers) - pad
    t0 = min(lt for _, _, lt, _ in layers) - pad
    x1 = max(lx + _pt(img.width) for img, lx, _, _ in layers) + pad
    t1 = max(lt + _pt(img.height) for img, _, lt, _ in layers) + pad
    x0, t0 = max(0.0, x0), max(0.0, t0)
    return x0, t0, min(PAGE_W, x1) - x0, min(PAGE_H, t1) - t0


def _draw_sparkles(c: pdfcanvas.Canvas, theme: Theme, seed: int, count: int,
                   avoid: Sequence[tuple[float, float, float, float]]) -> None:
    """Little four-point sparkles and dots, in the open space of a page."""
    if not theme.soft:
        return
    rnd = random.Random(seed)
    colours = [theme.accent, "#a996d6", "#f3ad7f", "#c4b4e6"]
    pad = 10.0
    placed = tries = 0
    while placed < count and tries < count * 60:
        tries += 1
        x = rnd.uniform(MARGIN * 0.45, PAGE_W - MARGIN * 0.45)
        top = rnd.uniform(MARGIN * 0.9, PAGE_H - MARGIN * 0.8)
        if any(ax - pad < x < ax + aw + pad and at - pad < top < at + ah + pad
               for ax, at, aw, ah in avoid):
            continue
        placed += 1
        y = PAGE_H - top
        c.setFillColor(_hex(rnd.choice(colours), rnd.uniform(0.45, 0.85)))
        if rnd.random() < 0.55:
            r = rnd.uniform(3.5, 8.5)
            path = c.beginPath()
            path.moveTo(x, y + r)
            path.curveTo(x, y, x, y, x + r, y)
            path.curveTo(x, y, x, y, x, y - r)
            path.curveTo(x, y, x, y, x - r, y)
            path.curveTo(x, y, x, y, x, y + r)
            path.close()
            c.drawPath(path, stroke=0, fill=1)
        else:
            c.circle(x, y, rnd.uniform(1.2, 2.6), stroke=0, fill=1)


def _chip(c: pdfcanvas.Canvas, theme: Theme, text: str, x: float, y: float,
          size: float = 7.0) -> float:
    """A small rounded label; returns its width."""
    w = _tracked_width(c, text, BODY_BOLD, size, 1.4) + 18
    c.setFillColor(_hex(theme.accent, 0.13))
    c.roundRect(x, y - 6, w, size + 11, (size + 11) / 2, stroke=0, fill=1)
    c.setFillColor(_hex(theme.accent))
    _tracked(c, text, x + 9, y, BODY_BOLD, size, 1.4)
    return w


def _draw_lumi_cover(c: pdfcanvas.Canvas, theme: Theme, spec: CollageSpec,
                     page: PlannedPage) -> None:
    """Title on the left, the first photo in Lumi's hug on the right, and two
    more as polaroids taped beneath the title."""
    _draw_background(c, theme)
    col_w = PAGE_W * 0.45 - MARGIN

    hero = next((t for t in page.tiles if t.frame), None)
    prints = [t for t in page.tiles if t.polaroid is not None]
    avoid = [(MARGIN - 6, MARGIN - 6, col_w + 12, 250)]
    if hero:
        avoid.append((hero.x, hero.top, hero.w, hero.h))
    if prints:
        avoid.append((MARGIN - 24, prints[0].top - 30, 300, 215))
    _draw_sparkles(c, theme, 7, 18, avoid)

    top = PAGE_H - MARGIN - 14
    _chip(c, theme, "LUMINA  ·  PHOTO ALBUM", MARGIN, top)

    size = 50.0
    while size > 24 and len(_wrap(c, spec.title, DISPLAY, size, col_w, 3)) > 2:
        size -= 2.0
    y = top - 22 - size
    c.setFillColor(_hex(theme.ink))
    for line in _wrap(c, spec.title, DISPLAY, size, col_w, 3):
        c.setFont(DISPLAY, size)
        c.drawString(MARGIN, y, line)
        y -= size * 1.06
    # The default subtitle ("12 photos") only repeats the first stat pill.
    repeats_a_stat = any(spec.subtitle == f"{v} {l}" for v, l in spec.stats)
    if spec.subtitle and not repeats_a_stat:
        c.setFillColor(_hex(theme.muted))
        c.setFont(BODY, 11.5)
        c.drawString(MARGIN, y + 4, _fit(c, spec.subtitle, BODY, 11.5, col_w))
        y -= 22

    cursor = MARGIN
    for value, label in spec.stats:
        vw = c.stringWidth(value, DISPLAY, 15)
        lw = c.stringWidth(label, BODY_BOLD, 8)
        pill_w = vw + lw + 26
        # White pills on light pages; the theme's frame colour on dark ones,
        # where the ink is pale.
        c.setFillColor(_hex(theme.frame if theme.dark else "#ffffff", 0.92))
        c.setStrokeColor(_hex(theme.frame))
        c.setLineWidth(0.8)
        c.roundRect(cursor, y - 14, pill_w, 26, 13, stroke=1, fill=1)
        c.setFillColor(_hex(theme.ink))
        c.setFont(DISPLAY, 15)
        c.drawString(cursor + 11, y - 7, value)
        c.setFillColor(_hex(theme.muted))
        c.setFont(BODY_BOLD, 8)
        c.drawString(cursor + 15 + vw, y - 5.5, label)
        cursor += pill_w + 8

    layers = []
    for tile in prints:
        img = _polaroid_layer(theme, spec.photos[tile.photo_index], tile.w, tile.h,
                              tile.polaroid or 0.0)
        if img is not None:
            layers.append((img, *_centred_on(tile, img), True))
    if layers:
        _compose(c, theme, _layers_rect(layers), layers)

    if hero:
        _draw_framed(c, theme, spec, replace(hero, photo_h=hero.h))


def _draw_chapter_art(c: pdfcanvas.Canvas, theme: Theme, spec: CollageSpec,
                      page: PlannedPage) -> None:
    """The chapter's opening photo as a polaroid, with Lumi leaning on it."""
    layers = []
    tile = page.feature
    if tile is not None:
        img = _polaroid_layer(theme, spec.photos[tile.photo_index], tile.w, tile.h,
                              tile.polaroid or 0.0)
        if img is not None:
            layers.append((img, *_centred_on(tile, img), True))
    if page.character:
        placed = page.character
        try:
            layers.append((_lumi_layer(placed), placed.x, placed.top, True))
        except Exception:
            pass                   # a missing sprite never fails an export
    if layers:
        _compose(c, theme, _layers_rect(layers), layers)


def _draw_closing(c: pdfcanvas.Canvas, theme: Theme, spec: CollageSpec,
                  page: PlannedPage, total: int) -> None:
    """Lumi hugging the album goodbye."""
    _draw_background(c, theme)
    art = page.character
    avoid = [(MARGIN - 6, PAGE_H * 0.3, PAGE_W * 0.5, PAGE_H * 0.4)]
    if art:
        avoid.append((art.x, art.top, art.w, art.h))
    _draw_sparkles(c, theme, 97, 22, avoid)
    y = _draw_display_heading(c, theme, page.title, page.subtitle, top=PAGE_H * 0.42,
                              measure=(PAGE_W - MARGIN * 2) * 0.5)
    c.setFillColor(_hex(theme.ink, 0.8))
    c.setFont(BODY, 11)
    c.drawString(MARGIN, y - 44, "Thank you for letting Lumi look after your photos.")
    if art:
        try:
            _compose(c, theme, (art.x - 14, art.top - 14, art.w + 28, art.h + 28),
                     [(_lumi_layer(art), art.x, art.top, True)])
        except Exception:
            pass


def _draw_page_chrome(c: pdfcanvas.Canvas, theme: Theme, spec: CollageSpec,
                      page_no: int, total_pages: int) -> None:
    top = PAGE_H - MARGIN
    label = f"{page_no:02d} / {total_pages:02d}"

    if theme.soft:
        # Lumi's pages: the album name in a soft chip, the page in a pill, no rule.
        _chip(c, theme, spec.title.upper()[:48], MARGIN, top - 8, 6.4)
        w = _tracked_width(c, label, BODY_BOLD, 6.6, 1.2) + 16
        c.setFillColor(_hex("#ffffff", 0.85))
        c.roundRect(PAGE_W - MARGIN - w, top - 13, w, 16, 8, stroke=0, fill=1)
        c.setFillColor(_hex(theme.accent))
        _tracked(c, label, PAGE_W - MARGIN - w + 8, top - 8, BODY_BOLD, 6.6, 1.2)
        footer = "Curated by Lumi" if spec.character else spec.footer
        if footer:
            c.setFillColor(_hex(theme.muted, 0.85))
            _tracked(c, footer.upper(), MARGIN, MARGIN * 0.44, BODY_BOLD, 5.8, 1.3)
        return

    c.setFillColor(_hex(theme.muted, 0.9))
    _tracked(c, spec.title.upper()[:56], MARGIN, top - 7, BODY, 6.6, 1.6)

    c.setFillColor(_hex(theme.accent))
    w = _tracked_width(c, label, BODY_BOLD, 6.6, 1.4)
    _tracked(c, label, PAGE_W - MARGIN - w, top - 7, BODY_BOLD, 6.6, 1.4)

    c.setStrokeColor(_hex(theme.frame, 0.85))
    c.setLineWidth(0.5)
    c.line(MARGIN, top - 15, PAGE_W - MARGIN, top - 15)

    if spec.footer:
        c.setFillColor(_hex(theme.muted, 0.75))
        _tracked(c, spec.footer.upper(), MARGIN, MARGIN * 0.44, BODY, 5.8, 1.3)


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
    """Draw Lumi. Lumi is full colour, so the same sprite
    reads on every theme, dark ones included."""
    px_w = max(1, int(placed.w / 72.0 * TARGET_DPI))
    px_h = max(1, int(placed.h / 72.0 * TARGET_DPI))
    try:
        art = mascot.render(placed.pose, px_w, px_h, placed.outfit, placed.facing)
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

    name = _fit(c, placed.name, BODY_BOLD, 7.4, placed.size + 12)
    c.setFillColor(_hex(theme.ink, 0.92))
    c.setFont(BODY_BOLD, 7.4)
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
        _tracked(c, subtitle.upper(), MARGIN, y - 21, BODY, 7.0, 1.8)
    return y


def _draw_chapter(c: pdfcanvas.Canvas, theme: Theme, spec: CollageSpec,
                  page: PlannedPage, total: int) -> None:
    """A divider. Mostly empty, which is the point — it is a breath between
    two events, and Lumi, dressed for the next one, introduces it."""
    _draw_background(c, theme)
    _draw_page_chrome(c, theme, spec, page.number, total)

    if page.feature is not None:
        _draw_sparkles(c, theme, page.number * 31, 14, [
            (MARGIN - 6, PAGE_H * 0.3, PAGE_W * 0.36, PAGE_H * 0.3),
            (page.feature.x - 40, MARGIN, PAGE_W - page.feature.x + 40, PAGE_H - MARGIN * 2),
        ])
        _draw_chapter_art(c, theme, spec, page)
    elif page.character:
        _draw_character(c, theme, page.character)

    measure = (PAGE_W - MARGIN * 2) * (0.4 if page.feature else 0.48 if page.character else 0.76)
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
            if spec.character and any(t.frame for t in page.tiles):
                _draw_lumi_cover(c, theme, spec, page)
            else:
                _draw_cover(c, theme, spec, page)
        elif page.kind == "closing":
            _draw_closing(c, theme, spec, page, total)
        elif page.kind == "chapter":
            _draw_chapter(c, theme, spec, page, total)
        elif page.kind == "cast":
            _draw_cast(c, theme, spec, page, total)
        else:
            _draw_background(c, theme)
            _draw_page_chrome(c, theme, spec, page.number, total)
            # Lumi's framed photo first: its shadow may reach into the gutter,
            # and the neighbouring tiles should sit cleanly over that.
            for tile in sorted(page.tiles, key=lambda t: not t.frame):
                photo = spec.photos[tile.photo_index]
                if not (tile.frame and _draw_framed(c, theme, spec, tile)):
                    _draw_tile(c, theme, photo, tile.x,
                               PAGE_H - tile.top - tile.photo_h, tile.w, tile.photo_h)
                if tile.labelled:
                    _draw_tile_label(c, theme, photo, tile.number,
                                     tile.x, PAGE_H - tile.top - tile.h, tile.w)
            if page.character:
                _draw_character(c, theme, page.character)
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
