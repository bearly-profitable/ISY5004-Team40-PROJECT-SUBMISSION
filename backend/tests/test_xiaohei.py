"""Unit tests for the procedural 小黑 renderer.

Pure Pillow drawing — no network, no models — so these run in the lightweight
CI job. They guard the properties that matter downstream: the character always
fits the frame it was given, is reproducible from a seed, and is genuinely
redrawn (not recoloured) when the seed changes.
"""
import pytest

pytest.importorskip("PIL")

import xiaohei  # noqa: E402


def _alpha_bbox(img):
    return img.getchannel("A").getbbox()


def _ink_area(img, threshold=128):
    """Pixels the character actually covers."""
    mask = img.getchannel("A").point(lambda v: 255 if v > threshold else 0)
    return mask.histogram()[255]


def _opaque_colours(img):
    """[(count, (r, g, b, a)), ...] for the pixels that are actually drawn."""
    colours = img.getcolors(maxcolors=1 << 20) or []
    return [(count, colour) for count, colour in colours if colour[3] > 200]


def test_every_pose_and_body_renders():
    for pose in xiaohei.pose_keys():
        for body in xiaohei.body_keys():
            img = xiaohei.render(pose, body=body, size=(120, 120))
            assert img.mode == "RGBA"
            assert img.size == (120, 120)
            assert _alpha_bbox(img) is not None, f"{pose}/{body} drew nothing"


def test_unknown_pose_and_body_fall_back():
    fallback = xiaohei.render("no-such-pose", body="no-such-body", size=(64, 64))
    default = xiaohei.render(xiaohei.DEFAULT_POSE, body=xiaohei.DEFAULT_BODY, size=(64, 64))
    assert fallback.tobytes() == default.tobytes()


@pytest.mark.parametrize("size", [(40, 40), (120, 90), (90, 120), (600, 600)])
def test_the_character_fills_the_frame_without_clipping(size):
    """Fitting is the whole point: props and limbs must be inside the image,
    and the character must not shrink to a speck to make room for them."""
    for pose in xiaohei.pose_keys():
        img = xiaohei.render(pose, size=size)
        bbox = _alpha_bbox(img)
        assert bbox is not None
        left, top, right, bottom = bbox
        assert left >= 0 and top >= 0
        assert right <= size[0] and bottom <= size[1]
        # It should occupy most of at least one axis, whatever the props add.
        span = max((right - left) / size[0], (bottom - top) / size[1])
        assert span > 0.7, f"{pose} at {size} only spans {span:.2f}"


def test_the_same_seed_draws_the_same_character():
    a = xiaohei.render("carry", seed=4, size=(100, 100))
    b = xiaohei.render("carry", seed=4, size=(100, 100))
    assert a.tobytes() == b.tobytes()


def test_a_different_seed_redraws_rather_than_recolours():
    a = xiaohei.render("carry", seed=1, size=(140, 140))
    b = xiaohei.render("carry", seed=2, size=(140, 140))
    assert a.tobytes() != b.tobytes()
    # Same pose, so the silhouettes should differ in outline, not in bulk.
    area_a = _ink_area(a)
    area_b = _ink_area(b)
    assert abs(area_a - area_b) / max(area_a, 1) < 0.25


def test_bodies_are_actually_different_shapes():
    areas = {}
    for body in xiaohei.body_keys():
        img = xiaohei.render("stand", body=body, size=(160, 160))
        areas[body] = _ink_area(img)
    assert len(set(areas.values())) == len(areas), areas


def test_ink_colour_is_honoured_for_dark_pages():
    """On a dark theme 小黑 is drawn in the page's ink instead of black, which
    is the only way a solid black character survives a midnight background."""
    img = xiaohei.render("stand", size=(80, 80), ink=(244, 246, 251))
    drawn = _opaque_colours(img)
    assert drawn
    # The body dominates; it should be the pale ink, not black.
    _, body = max(drawn, key=lambda item: item[0])
    assert body[:3] == (244, 246, 251)


def test_facing_mirrors_the_character():
    left = xiaohei.render("carry", seed=3, size=(120, 120), facing=-1)
    right = xiaohei.render("carry", seed=3, size=(120, 120), facing=1)
    assert left.tobytes() != right.tobytes()
    from PIL import ImageOps
    assert ImageOps.mirror(left).tobytes() == right.tobytes()


def test_eyes_are_drawn_white_on_the_body():
    img = xiaohei.render("stand", size=(200, 200))
    white = sum(count for count, colour in _opaque_colours(img)
                if colour[0] > 240 and colour[1] > 240 and colour[2] > 240)
    assert white > 20, "no white dot eyes found"


def test_eyes_take_the_colour_they_are_given():
    """The eyes are holes in the body, not white paint. Drawn pale on a dark
    page, white eyes on a white body would vanish, so the caller passes the
    page's own colour and gets it."""
    pale = (244, 246, 251)
    page = (20, 24, 36)

    def count(img, colour):
        return sum(n for n, c in _opaque_colours(img) if c[:3] == colour)

    on_page = xiaohei.render("stand", size=(200, 200), ink=pale, eye=page)
    assert count(on_page, page) > 20, "eyes were not drawn in the page colour"

    # Change only the eye colour: the body is untouched and the dots follow.
    crimson = (200, 30, 40)
    recoloured = xiaohei.render("stand", size=(200, 200), ink=pale, eye=crimson)
    assert count(recoloured, crimson) > 20
    assert count(recoloured, page) == 0
    assert abs(count(recoloured, pale) - count(on_page, pale)) < 40

    # And they stay a small feature on a large body, not the other way round.
    assert count(on_page, page) < count(on_page, pale) * 0.1


def test_props_are_outlines_not_solids():
    """The character must stay the only mass in the frame."""
    plain = xiaohei.render("stand", size=(200, 200))
    carrying = xiaohei.render("carry", size=(200, 200))
    def ink_of(img):
        return sum(count for count, colour in _opaque_colours(img) if colour[0] < 40)

    # A stack of prints adds line work, not another filled shape.
    assert ink_of(carrying) < ink_of(plain) * 1.6


def test_cached_render_is_reused():
    a = xiaohei.cached("stand", "bean", 64, 64, 0, (0, 0, 0), -1)
    b = xiaohei.cached("stand", "bean", 64, 64, 0, (0, 0, 0), -1)
    assert a is b


def test_every_pose_has_a_description():
    """The library is the album's vocabulary; an unnamed pose is a dead one."""
    for key, pose in xiaohei.POSES.items():
        assert pose.key == key
        assert pose.description.strip()


def test_poses_the_album_depends_on_exist():
    for key in ("carry", "hang", "present", "tag", "file", "sweep", "point"):
        assert key in xiaohei.POSES
