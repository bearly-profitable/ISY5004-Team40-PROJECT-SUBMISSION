"""Themed PDF collage export.

Turns a set of curated photos into a designed, printable album rather than a
contact sheet. Three things do most of the work:

- **Varied mosaics.** A uniform grid reads as a spreadsheet. Each page picks a
  layout template sized to its photo count, so a hero image can dominate one
  spread and a rhythm of smaller frames the next.
- **Cover-cropping.** Photos are centre-cropped to fill their slot exactly, so
  there are no letterbox gaps and no distorted aspect ratios.
- **Themes.** Palette, background treatment and typography travel together, so
  swapping a theme restyles the whole document coherently.

Rendering is a Pillow/ReportLab split: Pillow does the pixel work (gradients,
cover-crops, rounded masks, grain) and ReportLab does vector type, rules and
page structure, which keeps text crisp at print resolution.
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
MARGIN = 34.0
GUTTER = 9.0
CORNER_RADIUS = 10.0

# Photos are rasterised at ~200dpi within their slot; beyond that the PDF
# balloons for no visible gain in print. Backgrounds are smooth gradients and
# need far less.
TARGET_DPI = 200.0
BG_DPI = 110.0
JPEG_QUALITY = 88

# Shadow bleed around each photo, in points.
SHADOW_BLEED = 7.0


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
    bg_top: str          # page gradient, top
    bg_bottom: str       # page gradient, bottom
    ink: str             # primary type
    muted: str           # secondary type
    accent: str          # rules, dots, accents
    frame: str           # thin border drawn around each photo
    grain: float         # 0..1 film-grain strength
    cover_serif: bool    # serif display type on the cover
    dark: bool

    @property
    def shadow_alpha(self) -> float:
        return 0.42 if self.dark else 0.18


THEMES: dict[str, Theme] = {
    "midnight": Theme(
        key="midnight", name="Midnight", bg_top="#12151f", bg_bottom="#05070c",
        ink="#f4f6fb", muted="#8e97ad", accent="#d8b26a", frame="#2a3040",
        grain=0.55, cover_serif=True, dark=True,
    ),
    "ivory": Theme(
        key="ivory", name="Ivory", bg_top="#fbf9f5", bg_bottom="#f0ebe2",
        ink="#1b1a18", muted="#8a8378", accent="#b08050", frame="#e0d8ca",
        grain=0.22, cover_serif=True, dark=False,
    ),
    "blush": Theme(
        key="blush", name="Blush", bg_top="#fdf2f1", bg_bottom="#f6dfe4",
        ink="#40282d", muted="#a3757f", accent="#d97b8c", frame="#f0cfd5",
        grain=0.18, cover_serif=False, dark=False,
    ),
    "mono": Theme(
        key="mono", name="Mono", bg_top="#ffffff", bg_bottom="#f2f2f2",
        ink="#0a0a0a", muted="#8c8c8c", accent="#0a0a0a", frame="#dcdcdc",
        grain=0.0, cover_serif=False, dark=False,
    ),
}
DEFAULT_THEME = "midnight"


# Fractional slot rects (x, y, w, h) with y measured from the top of the
# content box. Several options per count; pages alternate to avoid a repeating
# visual beat across a long album.
LAYOUTS: dict[int, list[list[tuple[float, float, float, float]]]] = {
    1: [
        [(0.0, 0.0, 1.0, 1.0)],
    ],
    2: [
        [(0.0, 0.0, 0.5, 1.0), (0.5, 0.0, 0.5, 1.0)],
        [(0.0, 0.0, 1.0, 0.56), (0.0, 0.56, 1.0, 0.44)],
    ],
    3: [
        [(0.0, 0.0, 0.62, 1.0), (0.62, 0.0, 0.38, 0.5), (0.62, 0.5, 0.38, 0.5)],
        [(0.0, 0.0, 0.38, 0.5), (0.0, 0.5, 0.38, 0.5), (0.38, 0.0, 0.62, 1.0)],
        [(0.0, 0.0, 1.0, 0.58), (0.0, 0.58, 0.5, 0.42), (0.5, 0.58, 0.5, 0.42)],
    ],
    4: [
        [(0.0, 0.0, 0.55, 0.56), (0.55, 0.0, 0.45, 0.56),
         (0.0, 0.56, 0.45, 0.44), (0.45, 0.56, 0.55, 0.44)],
        [(0.0, 0.0, 0.64, 0.62), (0.64, 0.0, 0.36, 0.31), (0.64, 0.31, 0.36, 0.31),
         (0.0, 0.62, 1.0, 0.38)],
    ],
    5: [
        [(0.0, 0.0, 0.64, 0.6), (0.64, 0.0, 0.36, 0.6),
         (0.0, 0.6, 0.34, 0.4), (0.34, 0.6, 0.32, 0.4), (0.66, 0.6, 0.34, 0.4)],
        [(0.0, 0.0, 0.34, 0.5), (0.0, 0.5, 0.34, 0.5), (0.34, 0.0, 0.66, 0.62),
         (0.34, 0.62, 0.33, 0.38), (0.67, 0.62, 0.33, 0.38)],
    ],
    6: [
        [(0.0, 0.0, 0.5, 0.52), (0.5, 0.0, 0.25, 0.52), (0.75, 0.0, 0.25, 0.52),
         (0.0, 0.52, 0.25, 0.48), (0.25, 0.52, 0.25, 0.48), (0.5, 0.52, 0.5, 0.48)],
        [(0.0, 0.0, 0.33, 0.5), (0.33, 0.0, 0.34, 0.5), (0.67, 0.0, 0.33, 0.5),
         (0.0, 0.5, 0.33, 0.5), (0.33, 0.5, 0.34, 0.5), (0.67, 0.5, 0.33, 0.5)],
    ],
}
MAX_PER_PAGE = max(LAYOUTS)


@dataclass
class CollagePhoto:
    path: Path
    caption: str = ""
    subcaption: str = ""


@dataclass
class CollageSpec:
    title: str = "Lumina Album"
    subtitle: str = ""
    theme: str = DEFAULT_THEME
    photos: list[CollagePhoto] = field(default_factory=list)
    footer: str = "Curated by Lumina"


# ---------------------------------------------------------------------------
# Pillow helpers
# ---------------------------------------------------------------------------

def _gradient_background(theme: Theme, width: int, height: int) -> Image.Image:
    """Vertical gradient with an off-centre glow and optional film grain."""
    top, bottom = _rgb(theme.bg_top), _rgb(theme.bg_bottom)
    base = Image.new("RGB", (1, height))
    px = base.load()
    for y in range(height):
        t = y / max(1, height - 1)
        # Smoothstep keeps the midtones from banding across a large page.
        t = t * t * (3 - 2 * t)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    img = base.resize((width, height), Image.BILINEAR)

    glow = Image.new("L", (width, height), 0)
    ImageDraw.Draw(glow).ellipse(
        [int(width * 0.06), int(-height * 0.42), int(width * 0.78), int(height * 0.52)],
        fill=58 if theme.dark else 40,
    )
    glow = glow.filter(ImageFilter.GaussianBlur(radius=max(width, height) * 0.11))
    tint = Image.new("RGB", (width, height), _rgb(theme.accent))
    img = Image.composite(Image.blend(img, tint, 0.16), img, glow)

    if theme.grain > 0:
        import random

        rnd = random.Random(0x11A)
        noise = Image.new("L", (width // 3 or 1, height // 3 or 1))
        noise.putdata([rnd.randint(0, 255) for _ in range(noise.width * noise.height)])
        noise = noise.resize((width, height), Image.BILINEAR)
        img = Image.blend(img, Image.merge("RGB", (noise, noise, noise)),
                          0.035 * theme.grain)
    return img


def _cover_crop(path: Path, box_w: float, box_h: float) -> Optional[Image.Image]:
    """Centre-crop to the slot's aspect ratio, then size for ~TARGET_DPI."""
    try:
        with Image.open(path) as src:
            img = ImageOps.exif_transpose(src).convert("RGB")
    except Exception:
        return None

    target_w = max(1, int(box_w / 72.0 * TARGET_DPI))
    target_h = max(1, int(box_h / 72.0 * TARGET_DPI))
    # Never upscale past the source: it only adds bytes and softness. Shrink the
    # target uniformly so the slot's aspect ratio (and so the crop) is unchanged.
    fit = min(1.0, img.width / target_w, img.height / target_h)
    if fit < 1.0:
        target_w = max(1, round(target_w * fit))
        target_h = max(1, round(target_h * fit))
    try:
        return ImageOps.fit(img, (target_w, target_h), Image.LANCZOS, centering=(0.5, 0.42))
    except Exception:
        return None


def _rounded_mask(size: tuple[int, int], radius_px: int) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1],
                                           radius=max(0, radius_px), fill=255)
    return mask


def _jpeg_reader(img: Image.Image, quality: int = JPEG_QUALITY) -> ImageReader:
    """Wrap a PIL image as a JPEG stream.

    ReportLab embeds a JPEG verbatim (DCTDecode). Handing it a PIL object with
    an alpha channel instead forces lossless Flate compression, which made a
    3-page album ~9 MB; going through JPEG puts the same album under 1 MB.
    """
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=quality, optimize=True)
    buf.seek(0)
    return ImageReader(buf)


# ---------------------------------------------------------------------------
# Drawing
# ---------------------------------------------------------------------------

_BG_CACHE: dict[str, Image.Image] = {}


def _background_image(theme: Theme) -> Image.Image:
    """Page background, rendered once per theme and reused across pages."""
    cached = _BG_CACHE.get(theme.key)
    if cached is None:
        cached = _gradient_background(
            theme,
            int(PAGE_W / 72.0 * BG_DPI),
            int(PAGE_H / 72.0 * BG_DPI),
        )
        _BG_CACHE[theme.key] = cached
    return cached


def _draw_background(c: pdfcanvas.Canvas, theme: Theme) -> None:
    c.drawImage(_jpeg_reader(_background_image(theme), 90), 0, 0,
                width=PAGE_W, height=PAGE_H)


def _draw_photo(
    c: pdfcanvas.Canvas,
    theme: Theme,
    photo: CollagePhoto,
    x: float,
    y: float,
    w: float,
    h: float,
) -> bool:
    """Draw one framed photo with a soft drop shadow. `y` is the PDF baseline.

    Shadow, rounded corners and the photo are composited over a crop of the page
    background in Pillow, so a single opaque JPEG reaches the PDF. Doing the
    shadow as stacked translucent rects on the canvas instead would leave the
    photo needing an alpha channel, which is what bloats the file.
    """
    img = _cover_crop(photo.path, w, h)
    if img is None:
        return False

    bleed = SHADOW_BLEED
    tile_x, tile_y = x - bleed, y - bleed
    tile_w, tile_h = w + bleed * 2, h + bleed * 2

    bg = _background_image(theme)
    px_per_pt = bg.width / PAGE_W
    # PDF origin is bottom-left, the image's is top-left.
    left = int(round(tile_x * px_per_pt))
    top = int(round((PAGE_H - tile_y - tile_h) * px_per_pt))
    right = left + max(1, int(round(tile_w * px_per_pt)))
    bottom = top + max(1, int(round(tile_h * px_per_pt)))
    tile = bg.crop((left, top, right, bottom)).convert("RGB")

    # Work at the photo's own resolution so the composite stays sharp.
    scale = img.width / max(w, 1e-6)
    tile = tile.resize(
        (max(1, round(tile_w * scale)), max(1, round(tile_h * scale))), Image.LANCZOS
    )
    inset = round(bleed * scale)
    radius_px = max(1, round(CORNER_RADIUS * scale))

    shadow = Image.new("L", tile.size, 0)
    ImageDraw.Draw(shadow).rounded_rectangle(
        [inset, inset + round(bleed * scale * 0.42),
         inset + img.width - 1, inset + img.height - 1 + round(bleed * scale * 0.42)],
        radius=radius_px, fill=round(255 * theme.shadow_alpha),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=max(1.0, bleed * scale * 0.42)))
    tile = Image.composite(Image.new("RGB", tile.size, (0, 0, 0)), tile, shadow)

    tile.paste(img, (inset, inset), _rounded_mask(img.size, radius_px))

    c.drawImage(_jpeg_reader(tile), tile_x, tile_y, width=tile_w, height=tile_h,
                preserveAspectRatio=False)

    c.setStrokeColor(_hex(theme.frame, 0.85))
    c.setLineWidth(0.6)
    c.roundRect(x, y, w, h, CORNER_RADIUS, stroke=1, fill=0)

    if photo.caption:
        _draw_caption(c, theme, photo, x, y, w, h)
    return True


def _draw_caption(
    c: pdfcanvas.Canvas, theme: Theme, photo: CollagePhoto,
    x: float, y: float, w: float, h: float,
) -> None:
    """Caption sits inside the photo's lower edge over a soft scrim."""
    pad = 9.0
    band_h = 27.0 if photo.subcaption else 19.0
    c.saveState()
    # Clip to the *photo's* rounded rect, not the band's: clipping to the band
    # would round its top corners too and notch the scrim mid-photo.
    p = c.beginPath()
    p.roundRect(x, y, w, h, CORNER_RADIUS)
    c.clipPath(p, stroke=0, fill=0)
    c.setFillColor(_hex("#000000", 0.44))
    c.rect(x, y, w, band_h + pad, stroke=0, fill=1)
    c.restoreState()

    text_y = y + (band_h - 11.0) + (1.0 if photo.subcaption else 0.0)
    c.setFillColor(_hex("#ffffff", 0.95))
    c.setFont("Helvetica-Bold", 7.6)
    c.drawString(x + pad, text_y, _fit(c, photo.caption.upper(), "Helvetica-Bold", 7.6, w - pad * 2))

    if photo.subcaption:
        c.setFillColor(_hex("#ffffff", 0.6))
        c.setFont("Helvetica", 6.8)
        c.drawString(x + pad, text_y - 9.5,
                     _fit(c, photo.subcaption, "Helvetica", 6.8, w - pad * 2))


def _fit(c: pdfcanvas.Canvas, text: str, font: str, size: float, max_w: float) -> str:
    """Truncate with an ellipsis so captions never overrun their frame."""
    if c.stringWidth(text, font, size) <= max_w:
        return text
    ell = "…"
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if c.stringWidth(text[:mid] + ell, font, size) <= max_w:
            lo = mid
        else:
            hi = mid - 1
    return text[:lo] + ell


def _tracked(c: pdfcanvas.Canvas, text: str, x: float, y: float,
             font: str, size: float, tracking: float) -> None:
    """Letter-spaced text — ReportLab has no tracking, so step glyph by glyph."""
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
    words, lines, cur = text.split(), [], ""
    for word in words:
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


def _draw_cover(c: pdfcanvas.Canvas, theme: Theme, spec: CollageSpec) -> None:
    _draw_background(c, theme)

    hero_h = PAGE_H * 0.5
    hero_y = MARGIN + 4
    if spec.photos:
        _draw_photo(c, theme, CollagePhoto(spec.photos[0].path),
                    MARGIN, hero_y, PAGE_W - MARGIN * 2, hero_h)

    top = PAGE_H - MARGIN
    c.setFillColor(_hex(theme.accent))
    c.circle(MARGIN + 3, top - 20, 3, stroke=0, fill=1)
    _tracked(c, "LUMINA", MARGIN + 14, top - 23, "Helvetica-Bold", 8.0, 2.6)

    c.setStrokeColor(_hex(theme.accent, 0.5))
    c.setLineWidth(0.7)
    c.line(MARGIN, top - 36, PAGE_W - MARGIN, top - 36)

    title_font = "Times-Roman" if theme.cover_serif else "Helvetica-Bold"
    size = 40.0
    max_w = PAGE_W - MARGIN * 2
    while size > 19 and c.stringWidth(spec.title, title_font, size) > max_w:
        size -= 1.0
    lines = _wrap(c, spec.title, title_font, size, max_w, 2)

    y = top - 78
    c.setFillColor(_hex(theme.ink))
    for line in lines:
        c.setFont(title_font, size)
        c.drawString(MARGIN, y, line)
        y -= size * 1.06

    if spec.subtitle:
        c.setFillColor(_hex(theme.muted))
        _tracked(c, spec.subtitle.upper(), MARGIN, y - 8, "Helvetica", 8.2, 1.7)

    # Accent rule anchored to the right edge, above the hero.
    c.setStrokeColor(_hex(theme.accent, 0.9))
    c.setLineWidth(2.0)
    rule_y = hero_y + hero_h + 17
    c.line(PAGE_W - MARGIN - 62, rule_y, PAGE_W - MARGIN, rule_y)


def _draw_page_chrome(c: pdfcanvas.Canvas, theme: Theme, spec: CollageSpec,
                      page_no: int, total_pages: int) -> None:
    top = PAGE_H - MARGIN
    c.setFillColor(_hex(theme.muted))
    _tracked(c, spec.title.upper()[:52], MARGIN, top - 9, "Helvetica", 6.8, 1.5)

    label = f"{page_no:02d} / {total_pages:02d}"
    c.setFont("Helvetica-Bold", 6.8)
    c.setFillColor(_hex(theme.accent))
    c.drawRightString(PAGE_W - MARGIN, top - 9, label)

    c.setStrokeColor(_hex(theme.frame, 0.9))
    c.setLineWidth(0.5)
    c.line(MARGIN, top - 17, PAGE_W - MARGIN, top - 17)

    if spec.footer:
        c.setFillColor(_hex(theme.muted, 0.8))
        _tracked(c, spec.footer.upper(), MARGIN, MARGIN * 0.46, "Helvetica", 6.0, 1.3)


def _chunk(photos: Sequence[CollagePhoto]) -> list[list[CollagePhoto]]:
    """Split into pages, avoiding a lonely single photo on the final page."""
    pages: list[list[CollagePhoto]] = []
    i, n = 0, len(photos)
    while i < n:
        remaining = n - i
        take = min(MAX_PER_PAGE, remaining)
        if remaining - take == 1 and take > 2:
            take -= 1  # leave 2 for the last page instead of 1
        pages.append(list(photos[i : i + take]))
        i += take
    return pages


def build_collage_pdf(spec: CollageSpec) -> bytes:
    """Render the album and return the PDF bytes."""
    if not spec.photos:
        raise ValueError("A collage needs at least one photo.")

    theme = THEMES.get(spec.theme, THEMES[DEFAULT_THEME])
    buf = io.BytesIO()
    c = pdfcanvas.Canvas(buf, pagesize=(PAGE_W, PAGE_H))
    c.setTitle(spec.title)
    c.setAuthor("Lumina")
    c.setSubject(spec.subtitle or "Curated photo album")

    _draw_cover(c, theme, spec)
    c.showPage()

    pages = _chunk(spec.photos)
    total = len(pages)
    content_top = PAGE_H - MARGIN - 26
    content_bottom = MARGIN + 14
    content_h = content_top - content_bottom
    content_w = PAGE_W - MARGIN * 2

    for page_no, batch in enumerate(pages, start=1):
        _draw_background(c, theme)
        _draw_page_chrome(c, theme, spec, page_no, total)

        options = LAYOUTS[len(batch)]
        slots = options[(page_no - 1) % len(options)]

        for photo, (fx, fy, fw, fh) in zip(batch, slots):
            x = MARGIN + fx * content_w + GUTTER / 2
            w = fw * content_w - GUTTER
            h = fh * content_h - GUTTER
            # Layout rects measure y downward from the content top; PDF y is up.
            y = content_top - (fy * content_h) - (fh * content_h) + GUTTER / 2
            if w > 1 and h > 1:
                _draw_photo(c, theme, photo, x, y, w, h)

        c.showPage()

    c.save()
    return buf.getvalue()


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
