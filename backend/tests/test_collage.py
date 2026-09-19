"""Unit tests for the themed PDF collage renderer.

Pure rendering — no network, no ML models — so these run in the lightweight
CI job alongside the other unit suites.
"""
import io

import pytest

pytest.importorskip("reportlab")

import collage  # noqa: E402


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


def test_every_layout_count_has_a_template():
    for count, options in collage.LAYOUTS.items():
        for slots in options:
            assert len(slots) == count, f"{count}: template has {len(slots)} slots"


def test_layout_slots_tile_the_content_box():
    """Slot areas should sum to the full box — no overlaps, no dead space."""
    for count, options in collage.LAYOUTS.items():
        for i, slots in enumerate(options):
            area = sum(w * h for _, _, w, h in slots)
            assert area == pytest.approx(1.0, abs=0.02), f"{count}[{i}] covers {area:.3f}"
            for x, y, w, h in slots:
                assert 0.0 <= x < 1.0 and 0.0 <= y < 1.0
                assert x + w <= 1.001 and y + h <= 1.001


def test_photo_counts_from_one_to_twenty(tmp_path):
    for count in range(1, 21):
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
