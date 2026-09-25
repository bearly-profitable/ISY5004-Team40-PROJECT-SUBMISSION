"""小黑 — the album's stagehand, drawn in code.

Adapted from Ian's `ian-xiaohei-illustrations` (MIT; see NOTICE in the README).
That project is a prompt skill: every picture is generated fresh by an image
model. An album cannot afford that — a twelve-page export would mean a dozen
model calls, a dozen seconds of latency, and twelve characters that do not
quite match each other. So the character is drawn here instead, from the
description in its `xiaohei-ip.md`:

    黑色实心小怪物 · 白色圆点眼睛 · 细腿 · 轮廓略微不规则，有手绘感 · 表情空、呆

Which is little enough geometry to express directly. A solid blob whose outline
carries low-frequency noise reads as hand-drawn; thin bent limbs and two white
dots do the rest. Because it is parametric, poses are data rather than files,
every size renders crisp at print DPI, and a reader can be given their own
silhouette without anybody drawing a second sprite sheet.

The IP's own rule is the one that shapes the pose library:

    如果去掉小黑，图的核心隐喻还能完全成立，说明小黑太装饰了

— if removing 小黑 leaves the meaning intact, 小黑 was decoration. So the poses
here are all *doing* the album's work: hauling prints between chapters, pegging
a photo to a line, handing out name tags. None of them stand and watch.
"""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Optional, Sequence

from PIL import Image, ImageDraw

#: Everything is modelled in unit space: the body is centred on the origin with
#: a nominal half-width of 1.0, and limbs and props are placed relative to it.
#: The renderer fits whatever that adds up to into the image it was asked for.
SUPERSAMPLE = 4

LEG_WIDTH = 0.055
ARM_WIDTH = 0.045
PROP_WIDTH = 0.035
EYE_RADIUS = 0.082


# ---------------------------------------------------------------------------
# Character parts
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Body:
    """A silhouette. These are the shapes the IP doc lists as interchangeable:
    圆柱、黑豆、黑盒、漏斗 — cylinder, bean, box, funnel."""

    key: str
    name: str
    rx: float
    ry: float
    #: Superellipse exponent. 2 is a plain ellipse; higher squares the corners.
    exponent: float = 2.0
    #: Narrows the shape toward its feet, which is what makes a funnel a funnel.
    taper: float = 0.0
    #: How irregular the outline is. The character should look drawn, not
    #: plotted, but the source is explicit that it is not cute or wobbly-cute.
    wobble: float = 0.035


BODIES: dict[str, Body] = {
    "bean": Body("bean", "Bean", rx=1.0, ry=0.72, exponent=2.0, wobble=0.04),
    "cylinder": Body("cylinder", "Cylinder", rx=0.66, ry=1.0, exponent=3.2, wobble=0.03),
    "box": Body("box", "Box", rx=0.86, ry=0.80, exponent=4.6, wobble=0.025),
    "funnel": Body("funnel", "Funnel", rx=0.95, ry=0.85, exponent=2.4, taper=0.62,
                   wobble=0.03),
    "shadow": Body("shadow", "Shadow", rx=1.12, ry=0.52, exponent=2.0, wobble=0.07),
}
DEFAULT_BODY = "bean"


@dataclass(frozen=True)
class Prop:
    """A line-art object the character is working with.

    Props are drawn in outline, never filled black, so the solid character stays
    the only mass in the frame — the style DNA asks for 黑色手绘线稿 with the
    character as the one solid.
    """

    kind: str                       # prints | photo | tag | broom | pin | plank
    x: float
    y: float
    scale: float = 1.0
    angle: float = 0.0


@dataclass(frozen=True)
class Pose:
    key: str
    description: str
    #: Body tilt in degrees; positive leans the character forward (to its left).
    lean: float = 0.0
    #: Where the feet land, in unit space. Two is normal; one reads as mid-step.
    feet: tuple[tuple[float, float], ...] = ((-0.34, 1.62), (0.30, 1.66))
    #: Where the hands reach. Empty means the arms are tucked away.
    hands: tuple[tuple[float, float], ...] = ()
    props: tuple[Prop, ...] = ()
    #: Free line work — a washing line, the lip of a drawer, the floor.
    strokes: tuple[tuple[tuple[float, float], ...], ...] = ()
    #: Nudges the eyes, which is the only expression the character has.
    eye_shift: tuple[float, float] = (0.0, 0.0)


# The pose library. Each one is 小黑 performing a job the album actually needs
# doing, which is the difference between a character and a sticker.
POSES: dict[str, Pose] = {
    "stand": Pose(
        "stand", "Standing, waiting to be given something to do.",
        feet=((-0.30, 1.66), (0.28, 1.64)),
    ),
    "carry": Pose(
        "carry", "Hauling a stack of prints from one chapter to the next.",
        lean=8.0,
        feet=((-0.52, 1.60), (0.34, 1.70)),
        hands=((-1.32, 0.42),),
        props=(Prop("prints", -1.52, 0.30, scale=0.62, angle=-6.0),),
        eye_shift=(-0.03, 0.02),
    ),
    "hang": Pose(
        "hang", "Pegging a photograph to the line.",
        lean=-5.0,
        feet=((-0.26, 1.68), (0.34, 1.62)),
        hands=((-1.16, -0.94),),
        props=(
            Prop("photo", -1.30, -0.34, scale=0.66),
            Prop("pin", -1.22, -1.02, scale=0.44),
        ),
        strokes=(((-1.86, -1.08), (-1.0, -1.14), (0.2, -1.09), (1.42, -1.16)),),
        eye_shift=(-0.02, -0.04),
    ),
    "point": Pose(
        "point", "Pointing out the thing worth looking at.",
        feet=((-0.32, 1.64), (0.30, 1.66)),
        hands=((-1.44, 0.04),),
        eye_shift=(-0.04, 0.0),
    ),
    "present": Pose(
        "present", "Holding the title up, with some effort.",
        feet=((-0.48, 1.70), (0.46, 1.66)),
        hands=((-0.78, -1.02), (0.74, -1.06)),
        props=(Prop("plank", -0.02, -1.14, scale=1.0, angle=-2.0),),
        eye_shift=(0.0, -0.05),
    ),
    "file": Pose(
        "file", "Filing the index away, one number at a time.",
        lean=12.0,
        feet=((-0.40, 1.62), (0.36, 1.68)),
        hands=((-1.18, 0.86),),
        props=(Prop("tag", -1.34, 0.96, scale=0.52, angle=-10.0),),
        eye_shift=(-0.03, 0.05),
    ),
    "tag": Pose(
        "tag", "Handing out name tags to the cast.",
        feet=((-0.34, 1.64), (0.32, 1.66)),
        hands=((-1.30, -0.26),),
        props=(Prop("tag", -1.50, -0.34, scale=0.58, angle=6.0),),
        eye_shift=(-0.03, -0.01),
    ),
    "sweep": Pose(
        "sweep", "Sweeping the last page clear.",
        lean=10.0,
        feet=((-0.48, 1.62), (0.32, 1.70)),
        hands=((-1.06, 0.30),),
        props=(Prop("broom", -1.24, 0.42, scale=0.95, angle=-24.0),),
        eye_shift=(-0.03, 0.03),
    ),
}
DEFAULT_POSE = "stand"


# ---------------------------------------------------------------------------
# Hand-drawn primitives
# ---------------------------------------------------------------------------

def _outline(body: Body, seed: int, samples: int = 168) -> list[tuple[float, float]]:
    """The body as a closed curve with a slightly uneven edge.

    The unevenness is a sum of a few low-frequency harmonics rather than
    per-vertex noise: high-frequency jitter reads as a bad render, whereas a
    handful of slow undulations reads as a pen that did not quite close the
    loop. 轮廓略微不规则.
    """
    rnd = random.Random(seed * 7919 + 13)
    harmonics = [(k, body.wobble * rnd.uniform(0.35, 1.0) / k,
                  rnd.uniform(0, math.tau)) for k in (2, 3, 5, 7)]

    points: list[tuple[float, float]] = []
    for i in range(samples):
        theta = math.tau * i / samples
        # Superellipse: exponent 2 is an ellipse, higher squares it off.
        cos_t, sin_t = math.cos(theta), math.sin(theta)
        power = 2.0 / body.exponent
        sx = math.copysign(abs(cos_t) ** power, cos_t)
        sy = math.copysign(abs(sin_t) ** power, sin_t)

        ripple = 1.0 + sum(amp * math.sin(k * theta + phase)
                           for k, amp, phase in harmonics)
        x = body.rx * sx * ripple
        y = body.ry * sy * ripple
        if body.taper:
            # y runs downward, so the shape narrows toward the feet.
            x *= 1.0 - body.taper * (y / body.ry + 1.0) / 2.0
        points.append((x, y))
    return points


def _bezier(p0: tuple[float, float], p1: tuple[float, float],
            control: tuple[float, float], steps: int = 18) -> list[tuple[float, float]]:
    out = []
    for i in range(steps + 1):
        t = i / steps
        u = 1.0 - t
        out.append((
            u * u * p0[0] + 2 * u * t * control[0] + t * t * p1[0],
            u * u * p0[1] + 2 * u * t * control[1] + t * t * p1[1],
        ))
    return out


def _limb(p0: tuple[float, float], p1: tuple[float, float],
          seed: int, bend: float = 0.16) -> list[tuple[float, float]]:
    """A thin limb: a gentle arc rather than a straight rule, so it looks drawn."""
    rnd = random.Random(seed * 104729 + 7)
    mx, my = (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    length = math.hypot(dx, dy) or 1e-6
    # Perpendicular offset, signed by the seed so limbs do not all curve alike.
    offset = bend * length * rnd.uniform(0.55, 1.25) * rnd.choice((-1.0, 1.0))
    control = (mx - dy / length * offset, my + dx / length * offset)
    return _bezier(p0, p1, control)


def _rotate(points: Sequence[tuple[float, float]], degrees: float,
            origin: tuple[float, float] = (0.0, 0.0)) -> list[tuple[float, float]]:
    if not degrees:
        return list(points)
    rad = math.radians(degrees)
    cos_a, sin_a = math.cos(rad), math.sin(rad)
    ox, oy = origin
    return [((x - ox) * cos_a - (y - oy) * sin_a + ox,
             (x - ox) * sin_a + (y - oy) * cos_a + oy) for x, y in points]


def _prop_strokes(prop: Prop) -> list[list[tuple[float, float]]]:
    """Props are outline only — the character stays the one solid in the frame."""
    s = prop.scale
    shapes: list[list[tuple[float, float]]] = []

    def rect(cx: float, cy: float, w: float, h: float) -> list[tuple[float, float]]:
        return [(cx - w, cy - h), (cx + w, cy - h), (cx + w, cy + h),
                (cx - w, cy + h), (cx - w, cy - h)]

    if prop.kind == "prints":
        # A leaning stack; the offsets are what make it read as more than one.
        for i in range(3):
            shapes.append(rect(i * 0.05 * s, -i * 0.13 * s, 0.34 * s, 0.26 * s))
    elif prop.kind == "photo":
        shapes.append(rect(0, 0, 0.36 * s, 0.44 * s))
        shapes.append(rect(0, 0.08 * s, 0.26 * s, 0.24 * s))   # the image within
    elif prop.kind == "tag":
        shapes.append(rect(0, 0, 0.42 * s, 0.24 * s))
        shapes.append([(-0.42 * s, -0.02 * s), (-0.58 * s, -0.10 * s)])  # its string
    elif prop.kind == "pin":
        shapes.append(rect(0, 0, 0.12 * s, 0.18 * s))
    elif prop.kind == "plank":
        shapes.append(rect(0, 0, 0.92 * s, 0.17 * s))
    elif prop.kind == "broom":
        shapes.append([(0, -0.70 * s), (0, 0.52 * s)])           # handle
        shapes.append([(-0.28 * s, 0.52 * s), (0.28 * s, 0.52 * s),
                       (0.20 * s, 0.86 * s), (-0.20 * s, 0.86 * s),
                       (-0.28 * s, 0.52 * s)])                    # head
        for i in range(-2, 3):
            shapes.append([(i * 0.09 * s, 0.56 * s), (i * 0.10 * s, 0.84 * s)])

    return [_rotate([(x + prop.x, y + prop.y) for x, y in
                     _rotate(shape, prop.angle)], 0.0) for shape in shapes]


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

@dataclass
class _Geometry:
    body: list[tuple[float, float]]
    eyes: list[tuple[float, float, float]]          # x, y, radius
    limbs: list[list[tuple[float, float]]]
    limb_widths: list[float]
    props: list[list[tuple[float, float]]]
    strokes: list[list[tuple[float, float]]]


def _build(pose: Pose, body: Body, seed: int, facing: int) -> _Geometry:
    outline = _rotate(_outline(body, seed), pose.lean)

    # Limbs hang off the bottom and sides of the body, then reach their targets.
    limbs: list[list[tuple[float, float]]] = []
    widths: list[float] = []

    hip_y = body.ry * 0.74
    for i, foot in enumerate(pose.feet):
        hip = (body.rx * (-0.30 if i == 0 else 0.30), hip_y)
        limbs.append(_limb(_rotate([hip], pose.lean)[0], foot, seed + i, bend=0.10))
        widths.append(LEG_WIDTH)

    shoulder_y = -body.ry * 0.10
    for i, hand in enumerate(pose.hands):
        side = -1.0 if hand[0] < 0 else 1.0
        shoulder = (body.rx * 0.72 * side, shoulder_y)
        limbs.append(_limb(_rotate([shoulder], pose.lean)[0], hand,
                           seed + 40 + i, bend=0.13))
        widths.append(ARM_WIDTH)

    # Two white dots, set toward the face, nudged by the pose.
    ex, ey = pose.eye_shift
    eye_y = -body.ry * 0.30 + ey
    eyes_unit = [
        (-body.rx * 0.46 + ex, eye_y, EYE_RADIUS),
        (-body.rx * 0.13 + ex, eye_y - 0.015, EYE_RADIUS * 0.94),
    ]
    eyes = [(*_rotate([(x, y)], pose.lean)[0], r) for x, y, r in eyes_unit]

    props = [list(shape) for prop in pose.props for shape in _prop_strokes(prop)]
    strokes = [list(stroke) for stroke in pose.strokes]

    geometry = _Geometry(outline, eyes, limbs, widths, props, strokes)
    if facing > 0:
        _mirror(geometry)
    return geometry


def _mirror(geometry: _Geometry) -> None:
    geometry.body = [(-x, y) for x, y in geometry.body]
    geometry.eyes = [(-x, y, r) for x, y, r in geometry.eyes]
    geometry.limbs = [[(-x, y) for x, y in limb] for limb in geometry.limbs]
    geometry.props = [[(-x, y) for x, y in shape] for shape in geometry.props]
    geometry.strokes = [[(-x, y) for x, y in s] for s in geometry.strokes]


def _bounds(geometry: _Geometry, pad: float) -> tuple[float, float, float, float]:
    xs: list[float] = []
    ys: list[float] = []
    for group in (geometry.body, *geometry.limbs, *geometry.props, *geometry.strokes):
        for x, y in group:
            xs.append(x)
            ys.append(y)
    for x, y, r in geometry.eyes:
        xs.extend((x - r, x + r))
        ys.extend((y - r, y + r))
    return min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad


def render(
    pose: str = DEFAULT_POSE,
    *,
    body: str = DEFAULT_BODY,
    size: tuple[int, int] = (320, 320),
    seed: int = 0,
    ink: tuple[int, int, int] = (0, 0, 0),
    eye: tuple[int, int, int] = (255, 255, 255),
    facing: int = -1,
    include_strokes: bool = True,
) -> Image.Image:
    """Draw 小黑 as an RGBA image of exactly ``size``.

    ``facing`` is -1 for left (the default) or +1 for right. ``seed`` changes
    the outline's irregularity and the bend of the limbs without changing the
    pose, so two characters on one page are recognisably the same creature and
    visibly not the same drawing.

    ``eye`` is the colour of the two dots. They are holes in the body rather
    than white paint, so a caller drawing 小黑 in pale ink on a dark page must
    pass that page's colour — otherwise white eyes on a white body disappear.
    """
    shape = BODIES.get(body, BODIES[DEFAULT_BODY])
    action = POSES.get(pose, POSES[DEFAULT_POSE])
    geometry = _build(action, shape, seed, facing)
    if not include_strokes:
        geometry.strokes = []

    width, height = max(1, size[0]), max(1, size[1])
    ss = SUPERSAMPLE
    canvas = Image.new("RGBA", (width * ss, height * ss), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    # Fit the whole figure, limbs and props included, into the frame.
    x0, y0, x1, y1 = _bounds(geometry, pad=LEG_WIDTH * 1.5)
    scale = min(width * ss / max(x1 - x0, 1e-6), height * ss / max(y1 - y0, 1e-6))
    off_x = (width * ss - (x1 - x0) * scale) / 2 - x0 * scale
    off_y = (height * ss - (y1 - y0) * scale) / 2 - y0 * scale

    def to_px(points: Sequence[tuple[float, float]]) -> list[tuple[float, float]]:
        return [(x * scale + off_x, y * scale + off_y) for x, y in points]

    stroke = (*ink, 255)

    # Line work sits behind the character: the washing line runs past it, the
    # character is in front of it.
    for line in geometry.strokes:
        draw.line(to_px(line), fill=stroke, width=max(1, round(PROP_WIDTH * scale * 0.7)),
                  joint="curve")

    for limb, limb_width in zip(geometry.limbs, geometry.limb_widths):
        pixels = to_px(limb)
        thickness = max(1, round(limb_width * scale))
        draw.line(pixels, fill=stroke, width=thickness, joint="curve")
        # Round off the ends; PIL has no line caps.
        for px, py in (pixels[0], pixels[-1]):
            r = thickness / 2
            draw.ellipse([px - r, py - r, px + r, py + r], fill=stroke)

    draw.polygon(to_px(geometry.body), fill=stroke)

    for x, y, radius in geometry.eyes:
        cx, cy = x * scale + off_x, y * scale + off_y
        r = radius * scale
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(*eye, 255))

    for shape_points in geometry.props:
        if len(shape_points) < 2:
            continue
        draw.line(to_px(shape_points), fill=stroke,
                  width=max(1, round(PROP_WIDTH * scale * 0.8)), joint="curve")

    return canvas.resize((width, height), Image.LANCZOS)


@lru_cache(maxsize=256)
def cached(pose: str, body: str, width: int, height: int, seed: int,
           ink: tuple[int, int, int], facing: int,
           eye: tuple[int, int, int] = (255, 255, 255)) -> Image.Image:
    """Memoised `render`, for albums that reuse a pose on every chapter page."""
    return render(pose, body=body, size=(width, height), seed=seed,
                  ink=ink, eye=eye, facing=facing)


def pose_keys() -> list[str]:
    return list(POSES)


def body_keys() -> list[str]:
    return list(BODIES)
