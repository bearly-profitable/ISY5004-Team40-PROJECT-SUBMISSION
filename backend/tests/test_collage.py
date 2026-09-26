"""Unit tests for the themed PDF collage renderer.

Pure rendering — no network, no ML models — so these run in the lightweight
CI job alongside the other unit suites.
"""
import pathlib
import re

import pytest

pytest.importorskip("reportlab")

import collage  # noqa: E402
import mascot  # noqa: E402


def _photo(tmp_path, name: str, size=(400, 300), colour="skyblue"):
    from PIL import Image

    path = tmp_path / name
    Image.new("RGB", size, colour).save(path, format="JPEG")
    return collage.CollagePhoto(path=path, caption="Beach", subcaption="Alex")


def _pdf(tmp_path, count=5, **kwargs):
    photos = [_photo(tmp_path, f"p{i}.jpg") for i in range(count)]
    spec = collage.CollageSpec(photos=photos, **kwargs)
    return collage.build_collage_pdf(spec)


def test_produces_a_valid_pdf(tmp_path):
    data = _pdf(tmp_path, title="Summer", subtitle="5 photos")
    assert data.startswith(b"%PDF")
    assert data.rstrip().endswith(b"%%EOF")


def test_every_theme_renders(tmp_path):
    for key in collage.THEMES:
        assert _pdf(tmp_path, count=3, theme=key).startswith(b"%PDF")


def test_unknown_theme_falls_back_to_default(tmp_path):
    assert _pdf(tmp_path, count=2, theme="does-not-exist").startswith(b"%PDF")


def test_every_bento_template_has_the_right_slot_count():
    for count, options in collage.BENTO.items():
        for slots in options:
            assert len(slots) == count, f"{count}: template has {len(slots)} slots"


def test_bento_templates_tile_the_grid_exactly():
    """Every cell covered once: no overlaps, no dead space, no overflow."""
    grid = collage.GRID
    for count, options in collage.BENTO.items():
        for i, slots in enumerate(options):
            cells: set[tuple[int, int]] = set()
            for col, row, cspan, rspan in slots:
                assert cspan > 0 and rspan > 0, f"{count}[{i}] has a zero span"
                assert 0 <= col and col + cspan <= grid, f"{count}[{i}] overflows in x"
                assert 0 <= row and row + rspan <= grid, f"{count}[{i}] overflows in y"
                for cc in range(col, col + cspan):
                    for rr in range(row, row + rspan):
                        assert (cc, rr) not in cells, f"{count}[{i}] overlaps at {cc},{rr}"
                        cells.add((cc, rr))
            assert len(cells) == grid * grid, f"{count}[{i}] covers {len(cells)}/{grid * grid}"


def test_bento_pages_hold_more_than_a_handful():
    assert collage.MAX_PER_PAGE >= 9


def test_captions_are_never_drawn_over_the_photo():
    """Regression guard: an earlier version darkened every tile with a scrim."""
    source = pathlib.Path(collage.__file__).read_text(encoding="utf-8")

    # The label helper draws text only - no filled rect, no clip path.
    label_fn = source[source.index("def _draw_tile_label("):source.index("def _draw_cover(")]
    for banned in ("fill=1", "clipPath", "beginPath", "setFillAlpha"):
        assert banned not in label_fn, f"_draw_tile_label uses {banned}"

    # The tile helper composites the photo and never darkens it afterwards.
    # Rectangles are allowed — flat themes carry the tile edge with a square
    # keyline — but every one of them must be stroke-only.
    tile_fn = source[source.index("def _draw_tile("):source.index("def _draw_tile_label(")]
    for call in re.finditer(r"c\.(?:round)?[Rr]ect\((.*?)\)", tile_fn, re.S):
        assert "fill=0" in call.group(1), f"tile draws a filled rect: {call.group(0)}"

    # Labels get their own reserved band under the photo.
    assert "CAPTION_H" in source
    assert "photo_h = h_full - (CAPTION_H + CAPTION_GAP" in source


def test_photo_counts_from_one_to_thirty(tmp_path):
    for count in range(1, 31):
        assert _pdf(tmp_path, count=count).startswith(b"%PDF")


def test_chunking_never_strands_a_single_photo():
    for total in range(1, 60):
        pages = collage._chunk([object()] * total)  # type: ignore[list-item]
        assert sum(len(page) for page in pages) == total
        assert all(1 <= len(page) <= collage.MAX_PER_PAGE for page in pages)
        if total > 1:
            assert len(pages[-1]) != 1, f"{total} photos strands one on the last page"


def test_empty_photo_list_is_rejected():
    with pytest.raises(ValueError):
        collage.build_collage_pdf(collage.CollageSpec(photos=[]))


def test_unreadable_photo_is_skipped_not_fatal(tmp_path):
    broken = tmp_path / "broken.jpg"
    broken.write_bytes(b"this is not an image")
    photos = [_photo(tmp_path, "ok.jpg"), collage.CollagePhoto(path=broken)]
    assert collage.build_collage_pdf(
        collage.CollageSpec(photos=photos, title="Partial")
    ).startswith(b"%PDF")


def test_cover_crop_matches_the_slot_aspect_ratio(tmp_path):
    from PIL import Image

    path = tmp_path / "wide.jpg"
    Image.new("RGB", (4000, 1000), "red").save(path, format="JPEG")
    out = collage._cover_crop(path, 200.0, 100.0)
    assert out is not None
    assert out.width / out.height == pytest.approx(2.0, abs=0.02)


def test_cover_crop_never_upscales(tmp_path):
    from PIL import Image

    path = tmp_path / "small.jpg"
    Image.new("RGB", (60, 60), "red").save(path, format="JPEG")
    out = collage._cover_crop(path, 400.0, 400.0)  # would be ~1111px at 200dpi
    assert out is not None
    assert max(out.size) <= 60


def test_long_titles_and_captions_do_not_crash(tmp_path):
    photos = [
        collage.CollagePhoto(
            path=_photo(tmp_path, "p.jpg").path,
            caption="A caption far too long to fit inside its frame " * 4,
            subcaption="Alex · Sam · Jordan · Riley · Morgan · Casey " * 3,
        )
    ]
    data = collage.build_collage_pdf(
        collage.CollageSpec(photos=photos, title="An Extremely Long Album Title " * 5)
    )
    assert data.startswith(b"%PDF")


def test_jpeg_embedding_keeps_the_file_small(tmp_path):
    """Regression guard: alpha channels forced Flate and ~10x larger PDFs."""
    data = _pdf(tmp_path, count=6)
    assert len(data) < 3_000_000, f"{len(data)} bytes — JPEG embedding may have regressed"


def test_suggest_title_falls_back_without_a_key(monkeypatch):
    import openrouter

    monkeypatch.setattr(openrouter, "is_configured", lambda: False)
    title, subtitle = collage.suggest_title(4, ["Beach", "Dinner"], ["Alex"])
    assert title == "Beach"
    assert "4 photo" in subtitle


def test_suggest_title_survives_a_model_failure(monkeypatch):
    import openrouter

    monkeypatch.setattr(openrouter, "is_configured", lambda: True)
    monkeypatch.setattr(openrouter, "complete_text",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    title, _ = collage.suggest_title(2, ["Picnic"], [])
    assert title == "Picnic"


def test_suggest_title_parses_the_model_reply(monkeypatch):
    import openrouter

    monkeypatch.setattr(openrouter, "is_configured", lambda: True)
    monkeypatch.setattr(openrouter, "complete_text",
                        lambda *a, **k: 'TITLE: "Golden Hour"\nSUBTITLE: a slow afternoon')
    assert collage.suggest_title(3, ["Beach"], []) == ("Golden Hour", "a slow afternoon")


# ---------------------------------------------------------------------------
# Face-aware cropping
# ---------------------------------------------------------------------------

def _group_photo(tmp_path, name="group.jpg", size=(1600, 900)):
    """A wide group shot with three faces spread across the frame."""
    from PIL import Image, ImageDraw

    w, h = size
    img = Image.new("RGB", size, "#888888")
    draw = ImageDraw.Draw(img)
    boxes_px = [(120, 180, 340, 430), (690, 160, 910, 410), (1260, 190, 1480, 440)]
    for box, colour in zip(boxes_px, ("#ee3333", "#33ee33", "#3333ee")):
        draw.ellipse(list(box), fill=colour)
    path = tmp_path / name
    img.save(path)
    faces = [(x1 / w, y1 / h, x2 / w, y2 / h) for x1, y1, x2, y2 in boxes_px]
    return path, faces, boxes_px


def _face_coverage(left, top, crop_w, crop_h, boxes_px):
    out = []
    for x1, y1, x2, y2 in boxes_px:
        ox = max(0, min(x2, left + crop_w) - max(x1, left))
        oy = max(0, min(y2, top + crop_h) - max(y1, top))
        out.append((ox * oy) / ((x2 - x1) * (y2 - y1)))
    return out


def test_crop_never_slices_a_face_in_half(tmp_path):
    """The reported bug: a centre crop cut faces down the middle."""
    _, faces, boxes_px = _group_photo(tmp_path)
    w, h = 1600, 900
    spans = [(x1, x2) for x1, _, x2, _ in boxes_px]

    for box_w, box_h in ((240.0, 300.0), (300.0, 300.0), (420.0, 250.0), (200.0, 420.0)):
        ratio = box_w / box_h
        if w / h > ratio:
            crop_h, crop_w = h, int(round(h * ratio))
        else:
            crop_w, crop_h = w, int(round(w / ratio))
        left = collage._best_offset(w, crop_w, spans, 0.5)
        coverage = _face_coverage(left, 0, crop_w, crop_h, boxes_px)
        sliced = [c for c in coverage if 0.02 < c < 0.99]
        assert not sliced, f"slot {box_w}x{box_h} sliced a face: {coverage}"


def test_crop_keeps_more_faces_than_a_centre_crop(tmp_path):
    _, faces, boxes_px = _group_photo(tmp_path)
    w, h = 1600, 900
    spans = [(x1, x2) for x1, _, x2, _ in boxes_px]
    crop_w = 900  # square window

    centred = _face_coverage((w - crop_w) // 2, 0, crop_w, h, boxes_px)
    smart = _face_coverage(collage._best_offset(w, crop_w, spans, 0.5), 0, crop_w, h, boxes_px)

    assert sum(1 for c in smart if c > 0.99) > sum(1 for c in centred if c > 0.99)


def test_crop_without_faces_falls_back_to_the_bias():
    """No faces: centre horizontally, slightly high vertically."""
    assert collage._best_offset(1000, 500, [], 0.5) == 250
    assert collage._best_offset(1000, 500, [], 0.42) == 170


def test_offset_is_zero_when_no_crop_is_needed():
    assert collage._best_offset(800, 800, [(10.0, 90.0)], 0.5) == 0
    assert collage._best_offset(800, 900, [(10.0, 90.0)], 0.5) == 0


def test_offset_stays_inside_the_image():
    for window in (100, 400, 799):
        for spans in ([], [(0.0, 50.0)], [(750.0, 800.0)], [(0.0, 20.0), (780.0, 800.0)]):
            offset = collage._best_offset(800, window, spans, 0.5)
            assert 0 <= offset <= 800 - window


def test_cover_crop_accepts_faces_and_still_matches_the_slot(tmp_path):
    path, faces, _ = _group_photo(tmp_path)
    out = collage._cover_crop(path, 240.0, 300.0, faces)
    assert out is not None
    assert out.width / out.height == pytest.approx(240.0 / 300.0, abs=0.02)


def test_slots_are_matched_to_photo_shape(tmp_path):
    """Each photo lands in the slot whose proportions match its own."""
    from PIL import Image

    cell_w, cell_h = 60.0, 40.0
    # A wide banner slot and a tall column slot from the real grid.
    slots = [(0, 0, 12, 4), (0, 4, 3, 8)]
    aspects = [
        (cspan * cell_w - collage.GUTTER) / (rspan * cell_h - collage.GUTTER)
        for _, _, cspan, rspan in slots
    ]
    assert aspects[0] > 2.0 > aspects[1], aspects  # genuinely different shapes

    photos = []
    for i, aspect in enumerate(aspects):
        path = tmp_path / f"shape{i}.jpg"
        Image.new("RGB", (int(600 * aspect), 600), "grey").save(path)
        photos.append(collage.CollagePhoto(path=path))

    # photos[0] matches slot 0, photos[1] matches slot 1 — shuffle the input so
    # a pass-through ordering cannot accidentally satisfy the assertion.
    order = collage._assign_slots([photos[1], photos[0]], slots, cell_w, cell_h)
    assert order == [1, 0], f"assignment ignored photo shape: {order}"


def test_assignment_is_a_permutation(tmp_path):
    from PIL import Image

    paths = []
    for i, size in enumerate([(1600, 900), (900, 1600), (1200, 1200), (2000, 800), (800, 1200)]):
        path = tmp_path / f"a{i}.jpg"
        Image.new("RGB", size, "grey").save(path)
        paths.append(collage.CollagePhoto(path=path))

    for count in range(1, 6):
        for slots in collage.BENTO[count]:
            order = collage._assign_slots(paths[:count], slots, 60.0, 40.0)
            assert sorted(order) == list(range(count)), f"{count}: {order}"


def test_album_with_face_boxes_renders(tmp_path):
    path, faces, _ = _group_photo(tmp_path)
    photos = [
        collage.CollagePhoto(path=path, caption=f"Shot {i}", faces=faces)
        for i in range(6)
    ]
    data = collage.build_collage_pdf(collage.CollageSpec(photos=photos, title="Faces"))
    assert data.startswith(b"%PDF")


# ---------------------------------------------------------------------------
# Layout plan
#
# The plan is the contract between the printed album and the on-screen
# flip-book, so these guard the geometry itself rather than the pixels.
# ---------------------------------------------------------------------------

def _plan(tmp_path, count=5, **kwargs):
    photos = [_photo(tmp_path, f"p{i}.jpg") for i in range(count)]
    for i, photo in enumerate(photos):
        photo.photo_id = f"id-{i}"
    return collage.plan_album(collage.CollageSpec(photos=photos, **kwargs))


def test_plan_places_every_photo_exactly_once(tmp_path):
    for count in (1, 5, 9, 14, 23):
        plan = _plan(tmp_path, count=count)
        placed = [t.photo_index
                  for page in plan.pages if page.kind != "cover"
                  for t in page.tiles]
        assert sorted(placed) == list(range(count)), count


def test_plan_numbers_run_one_to_n(tmp_path):
    plan = _plan(tmp_path, count=17)
    numbers = sorted(t.number for page in plan.pages if page.kind != "cover"
                     for t in page.tiles)
    assert numbers == list(range(1, 18))


def test_plan_tiles_stay_on_the_page(tmp_path):
    for count in range(1, 25):
        plan = _plan(tmp_path, count=count)
        for page in plan.pages:
            for t in page.tiles:
                assert t.x >= 0 and t.top >= 0, (count, page.number)
                assert t.x + t.w <= collage.PAGE_W + 0.01, (count, page.number)
                assert t.top + t.h <= collage.PAGE_H + 0.01, (count, page.number)
                assert 0 < t.photo_h <= t.h


def test_plan_tiles_never_overlap(tmp_path):
    """The bento templates tile the grid; the points they map to must too."""
    for count in range(1, 25):
        plan = _plan(tmp_path, count=count)
        for page in plan.pages:
            if page.kind == "cover":
                continue
            for i, a in enumerate(page.tiles):
                for b in page.tiles[i + 1:]:
                    gap_x = a.x + a.w <= b.x + 0.01 or b.x + b.w <= a.x + 0.01
                    gap_y = a.top + a.h <= b.top + 0.01 or b.top + b.h <= a.top + 0.01
                    assert gap_x or gap_y, f"{count}: tiles overlap on page {page.number}"


def test_plan_page_count_matches_the_rendered_pdf(tmp_path):
    """A drifting page count would desynchronise the viewer from the download."""
    photos = [_photo(tmp_path, f"p{i}.jpg") for i in range(13)]
    spec = collage.CollageSpec(photos=photos, title="Sync")
    plan = collage.plan_album(spec)
    pdf = collage.build_collage_pdf(spec)
    assert pdf.count(b"/Type /Page\n") == len(plan.pages)
    assert plan.content_pages == len(plan.pages) - 1


def test_plan_reserves_a_caption_band_only_when_labelled(tmp_path):
    from PIL import Image

    path = tmp_path / "bare.jpg"
    Image.new("RGB", (400, 300), "grey").save(path)
    bare = collage.CollagePhoto(path=path)
    plan = collage.plan_album(collage.CollageSpec(photos=[bare]))
    tile = plan.pages[1].tiles[0]
    assert tile.photo_h == tile.h and not tile.labelled

    labelled = collage.CollagePhoto(path=path, caption="Beach")
    plan = collage.plan_album(collage.CollageSpec(photos=[labelled]))
    tile = plan.pages[1].tiles[0]
    assert tile.labelled
    assert tile.h - tile.photo_h == collage.CAPTION_H + collage.CAPTION_GAP


def test_plan_rejects_an_empty_album():
    with pytest.raises(ValueError):
        collage.plan_album(collage.CollageSpec(photos=[]))


def test_photographs_are_drawn_at_full_opacity(tmp_path):
    """Regression guard for a washed-out album.

    ReportLab's fill alpha is graphics state and applies to images too, so the
    footer — set at 0.75 by the page chrome that is drawn first — silently faded
    every photograph on every content page toward the paper colour. Images must
    go through `_draw_image`, which resets it.
    """
    source = pathlib.Path(collage.__file__).read_text(encoding="utf-8")

    helper = source[source.index("def _draw_image("):source.index("def _draw_background(")]
    assert "c.setFillAlpha(1.0)" in helper

    # Nothing else may call drawImage directly and skip the reset.
    after_helper = source[source.index("def _draw_image("):]
    assert after_helper.count("c.drawImage(") == 1, "a drawImage call bypasses _draw_image"

    # End to end: a solid photo must survive the page at its own value.
    pymupdf = pytest.importorskip("pymupdf")
    from PIL import Image

    path = tmp_path / "flat.jpg"
    Image.new("RGB", (900, 700), (20, 20, 20)).save(path, quality=98)
    photos = [collage.CollagePhoto(path=path, caption="Dark", subcaption="Alex")
              for _ in range(4)]
    data = collage.build_collage_pdf(
        collage.CollageSpec(photos=photos, title="Opacity", theme="mono"))

    doc = pymupdf.open(stream=data, filetype="pdf")
    pix = doc[1].get_pixmap(dpi=96)
    image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    counts = image.getcolors(maxcolors=1 << 22) or []
    darkest = min((colour for _, colour in counts), key=sum)
    assert sum(darkest) / 3 < 32, f"photos are being faded: darkest tone {darkest}"


# ---------------------------------------------------------------------------
# Chapters, cast and 小黑
# ---------------------------------------------------------------------------

def _chaptered(tmp_path, chapters):
    """[(label, count), ...] -> photos carrying those chapter labels."""
    photos = []
    for ci, (label, count) in enumerate(chapters):
        for i in range(count):
            photo = _photo(tmp_path, f"ch{ci}_{i}.jpg")
            photo.chapter = label
            photo.photo_id = f"{ci}-{i}"
            photos.append(photo)
    return photos


def test_a_divider_is_inserted_between_chapters(tmp_path):
    photos = _chaptered(tmp_path, [("Beach", 4), ("Dinner", 5), ("Fireworks", 3)])
    plan = collage.plan_album(collage.CollageSpec(photos=photos, title="Trip"))

    kinds = [page.kind for page in plan.pages]
    assert kinds.count("chapter") == 3
    titles = [page.title for page in plan.pages if page.kind == "chapter"]
    assert titles == ["Beach", "Dinner", "Fireworks"]

    # Every divider is immediately followed by its own photographs.
    for i, page in enumerate(plan.pages):
        if page.kind == "chapter":
            assert plan.pages[i + 1].kind == "bento"


def test_a_single_chapter_gets_no_divider(tmp_path):
    """One event is not a book with one chapter; it is just an album."""
    photos = _chaptered(tmp_path, [("Beach", 7)])
    plan = collage.plan_album(collage.CollageSpec(photos=photos))
    assert not any(page.kind == "chapter" for page in plan.pages)


def test_unlabelled_photos_never_produce_dividers(tmp_path):
    plan = _plan(tmp_path, count=12)
    assert not any(page.kind == "chapter" for page in plan.pages)


def test_a_chapter_never_shares_a_page_with_another(tmp_path):
    photos = _chaptered(tmp_path, [("Beach", 4), ("Dinner", 5), ("Fireworks", 11)])
    plan = collage.plan_album(collage.CollageSpec(photos=photos))
    for page in plan.pages:
        if page.kind != "bento":
            continue
        chapters = {photos[t.photo_index].chapter for t in page.tiles}
        assert len(chapters) == 1, f"page {page.number} mixes {chapters}"


def test_folio_numbers_are_continuous_across_every_page_kind(tmp_path):
    photos = _chaptered(tmp_path, [("Beach", 4), ("Dinner", 5)])
    cast = [collage.CastMember(name="Alex", path=photos[0].path)]
    plan = collage.plan_album(collage.CollageSpec(photos=photos, cast=cast))

    numbers = [page.number for page in plan.pages if page.kind != "cover"]
    assert numbers == list(range(1, len(numbers) + 1))
    assert plan.pages[0].kind == "cover" and plan.pages[0].number == 0
    assert plan.content_pages == len(numbers)


def test_dividers_do_not_disturb_bento_template_alternation(tmp_path):
    """Templates alternate per photo page, so a divider must not consume a turn
    and leave two identical layouts back to back."""
    plain = collage.plan_album(collage.CollageSpec(
        photos=[_photo(tmp_path, f"a{i}.jpg") for i in range(18)]))
    chaptered = collage.plan_album(collage.CollageSpec(
        photos=_chaptered(tmp_path, [("A", 9), ("B", 9)])))

    def shapes(plan):
        return [
            [(round(t.x, 3), round(t.top, 3), round(t.w, 3), round(t.h, 3))
             for t in page.tiles]
            for page in plan.pages if page.kind == "bento"
        ]

    assert shapes(plain) == shapes(chaptered)


def test_the_cast_page_leads_the_album(tmp_path):
    photos = _chaptered(tmp_path, [("Beach", 5)])
    cast = [collage.CastMember(name=n, path=photos[0].path, photo_id="0-0",
                               face=(0.3, 0.2, 0.6, 0.6))
            for n in ("Alex", "Sam", "Jordan")]
    plan = collage.plan_album(collage.CollageSpec(photos=photos, cast=cast))

    assert plan.pages[1].kind == "cast"
    page = plan.pages[1]
    assert len(page.portraits) == 3
    assert [p.name for p in page.portraits] == ["Alex", "Sam", "Jordan"]
    for portrait in page.portraits:
        assert portrait.size > 8
        assert portrait.x >= 0
        assert portrait.x + portrait.size <= collage.PAGE_W
        assert portrait.top + portrait.size <= collage.PAGE_H


def test_a_large_cast_wraps_and_still_fits(tmp_path):
    photos = _chaptered(tmp_path, [("Beach", 4)])
    for count in (1, 5, 6, 7, 12, 20):
        cast = [collage.CastMember(name=f"P{i}", path=photos[0].path)
                for i in range(count)]
        page = collage.plan_album(
            collage.CollageSpec(photos=photos, cast=cast)).pages[1]
        assert len(page.portraits) == min(count, 12)
        for portrait in page.portraits:
            assert portrait.size > 8, count
            assert portrait.x + portrait.size <= collage.PAGE_W + 0.01
            assert portrait.top + portrait.size <= collage.PAGE_H + 0.01


def test_the_character_only_appears_when_asked(tmp_path):
    photos = _chaptered(tmp_path, [("Beach", 4), ("Dinner", 4)])
    off = collage.plan_album(collage.CollageSpec(photos=photos))
    assert all(page.character is None for page in off.pages)

    on = collage.plan_album(collage.CollageSpec(photos=photos, character=True))
    # Lumi is on both dividers and on every page of photos.
    assert all(page.character for page in on.pages if page.kind != "cover")
    for page in on.pages:
        placed = page.character
        if placed is None:
            continue
        assert placed.pose in mascot.POSES
        assert placed.x >= 0 and placed.top >= 0
        assert placed.x + placed.w <= collage.PAGE_W + 0.01
        assert placed.top + placed.h <= collage.PAGE_H + 0.01


def test_lumi_dresses_for_the_chapter(tmp_path):
    photos = _chaptered(tmp_path, [("Beach", 3), ("Dinner", 3)])
    plan = collage.plan_album(collage.CollageSpec(photos=photos, character=True))
    poses = [page.character.pose for page in plan.pages if page.kind == "chapter"]
    assert poses == ["beach", "dinner"]


def test_lumi_on_a_photo_page_follows_its_photos(tmp_path):
    photos = _chaptered(tmp_path, [("Event 1", 3)])
    for photo in photos:
        photo.scene = "Birthday"
    plan = collage.plan_album(collage.CollageSpec(photos=photos, character=True))
    bento = next(page for page in plan.pages if page.kind == "bento")
    assert bento.character.pose == "birthday"


def test_lumi_on_photo_pages_stays_clear_of_the_photos(tmp_path):
    photos = _chaptered(tmp_path, [("Beach", 20)])
    plan = collage.plan_album(collage.CollageSpec(photos=photos, character=True))
    for page in plan.pages:
        if page.kind != "bento":
            continue
        lumi = page.character
        for tile in page.tiles:
            overlaps = (lumi.x < tile.x + tile.w and tile.x < lumi.x + lumi.w
                        and lumi.top < tile.top + tile.h and tile.top < lumi.top + lumi.h)
            assert not overlaps, (page.number, tile)


def test_the_character_wears_the_requested_outfit(tmp_path):
    photos = _chaptered(tmp_path, [("Beach", 3), ("Dinner", 3)])
    plan = collage.plan_album(collage.CollageSpec(
        photos=photos, character=True, character_outfit="mint"))
    assert all(page.character.outfit == "mint"
               for page in plan.pages if page.character)


def test_consecutive_dividers_use_different_poses(tmp_path):
    """Lumi repeating one action down the whole album would read as wallpaper."""
    photos = _chaptered(tmp_path, [(f"Ch{i}", 3) for i in range(4)])
    plan = collage.plan_album(collage.CollageSpec(photos=photos, character=True))
    poses = [page.character.pose for page in plan.pages if page.kind == "chapter"]
    assert len(set(poses)) == len(poses), poses


def test_consecutive_photo_pages_use_different_poses(tmp_path):
    photos = _chaptered(tmp_path, [("Beach", 24)])
    plan = collage.plan_album(collage.CollageSpec(photos=photos, character=True))
    poses = [page.character.pose for page in plan.pages if page.kind == "bento"]
    assert len(poses) > 2
    assert all(a != b for a, b in zip(poses, poses[1:])), poses


def test_an_album_with_chapters_cast_and_character_renders(tmp_path):
    photos = _chaptered(tmp_path, [("Beach", 5), ("Dinner", 6)])
    cast = [collage.CastMember(name="Alex", path=photos[0].path,
                               face=(0.3, 0.2, 0.6, 0.6))]
    for theme in collage.THEMES:
        data = collage.build_collage_pdf(collage.CollageSpec(
            photos=photos, cast=cast, character=True, theme=theme,
            title="Full Album"))
        assert data.startswith(b"%PDF")


def test_the_paper_theme_is_flat(tmp_path):
    paper = collage.THEMES["paper"]
    assert paper.flat
    assert paper.shadow_alpha == 0.0
    assert paper.radius == 0.0
    assert paper.bg_top == paper.bg_bottom
    assert paper.grain == 0.0

    # A flat background really is one solid colour, with no gradient or grain.
    image = collage._gradient_background(paper, 60, 40)
    assert image.getcolors() == [(60 * 40, collage._rgb(paper.bg_top))]


def test_the_cast_page_hands_out_name_tags(tmp_path):
    photos = _chaptered(tmp_path, [("Beach", 4), ("Dinner", 4)])
    cast = [collage.CastMember(name="Alex", path=photos[0].path, photo_id="0-0")]
    plan = collage.plan_album(collage.CollageSpec(
        photos=photos, cast=cast, character=True, theme="paper"))
    cast_page = next(p for p in plan.pages if p.kind == "cast")
    assert cast_page.title == "The cast"
    assert cast_page.character.pose == "tag"
    chapter = next(p for p in plan.pages if p.kind == "chapter")
    assert chapter.title == "Beach"
    assert chapter.character.pose == "beach"
    assert chapter.character.outfit == "classic"


# ---------------------------------------------------------------------------
# Lumi holding the photos
# ---------------------------------------------------------------------------

def test_lumi_holds_the_biggest_photo_on_every_page(tmp_path):
    photos = _chaptered(tmp_path, [("Beach", 14)])
    plan = collage.plan_album(collage.CollageSpec(photos=photos, character=True))
    for page in plan.pages:
        if page.kind != "bento":
            continue
        framed = [t for t in page.tiles if t.frame]
        assert len(framed) == 1, page.number
        biggest = max(page.tiles, key=lambda t: t.w * t.photo_h)
        assert framed[0] is biggest or framed[0].photo_index == biggest.photo_index
        assert framed[0].frame in mascot.frame_poses()


def test_no_frames_without_lumi(tmp_path):
    photos = _chaptered(tmp_path, [("Beach", 8)])
    plan = collage.plan_album(collage.CollageSpec(photos=photos))
    assert not any(t.frame or t.polaroid is not None for p in plan.pages for t in p.tiles)
    assert not any(p.kind == "closing" for p in plan.pages)


def test_neighbouring_pages_use_different_frames(tmp_path):
    photos = _chaptered(tmp_path, [("Beach", 30)])
    plan = collage.plan_album(collage.CollageSpec(photos=photos, character=True))
    frames = [t.frame for p in plan.pages if p.kind == "bento" for t in p.tiles if t.frame]
    assert len(frames) > 2
    assert all(a != b for a, b in zip(frames, frames[1:])), frames


def test_the_lumi_cover_hugs_the_first_photo(tmp_path):
    photos = _chaptered(tmp_path, [("Beach", 5)])
    cover = collage.plan_album(collage.CollageSpec(photos=photos, character=True)).pages[0]
    hero = next(t for t in cover.tiles if t.frame)
    assert hero.photo_index == 0
    assert [t.photo_index for t in cover.tiles if t.polaroid is not None] == [1, 2]
    for tile in cover.tiles:
        assert tile.x >= 0 and tile.x + tile.w <= collage.PAGE_W + 0.01
        assert tile.top >= 0 and tile.top + tile.h <= collage.PAGE_H + 0.01


def test_a_chapter_shows_its_opening_photo(tmp_path):
    photos = _chaptered(tmp_path, [("Beach", 3), ("Dinner", 4)])
    plan = collage.plan_album(collage.CollageSpec(photos=photos, character=True))
    chapters = [p for p in plan.pages if p.kind == "chapter"]
    assert [p.feature.photo_index for p in chapters] == [0, 3]
    for page in chapters:
        assert page.feature.polaroid is not None
        assert page.feature not in page.tiles      # art, not a numbered photo


def test_the_album_ends_with_lumi_saying_goodbye(tmp_path):
    photos = _chaptered(tmp_path, [("Beach", 6)])
    plan = collage.plan_album(collage.CollageSpec(photos=photos, character=True))
    assert plan.pages[-1].kind == "closing"
    assert plan.pages[-1].character.pose == "hug"


def test_a_lumi_album_renders_in_every_theme_and_outfit(tmp_path):
    photos = _chaptered(tmp_path, [("Beach", 5), ("Birthday", 4)])
    for photo in photos:
        photo.scene = photo.chapter
    for theme in collage.THEMES:
        for outfit in ("classic", "ocean"):
            data = collage.build_collage_pdf(collage.CollageSpec(
                photos=photos, character=True, theme=theme, character_outfit=outfit))
            assert data.startswith(b"%PDF")


def test_the_lumi_theme_is_the_default():
    assert collage.DEFAULT_THEME == "lumi"
    assert collage.THEMES["lumi"].soft

