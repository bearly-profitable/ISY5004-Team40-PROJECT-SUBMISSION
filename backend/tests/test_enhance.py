"""Unit tests for the AI enhancement path and its identity guard.

OpenRouter is always mocked here — these tests must never make a network call
or spend money. The ArcFace model is stubbed too, so the guard's *logic* is
what is under test, not InsightFace itself.
"""
import io

import numpy as np
import pytest

import enhance  # noqa: E402
import openrouter  # noqa: E402


def _jpeg(colour="white", size=(64, 64)) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", size, colour).save(buf, format="JPEG")
    return buf.getvalue()


class FakeFace:
    def __init__(self, embedding, bbox=(0, 0, 40, 40)):
        self.embedding = np.asarray(embedding, dtype=np.float32)
        self.bbox = np.asarray(bbox, dtype=np.float32)


class FakeFaceApp:
    """Returns a queued face list per call, in order."""

    def __init__(self, *responses):
        self._responses = list(responses)
        self.calls = 0

    def get(self, _bgr):
        self.calls += 1
        if not self._responses:
            return []
        return self._responses.pop(0)


def _vec(*values, dim=512):
    out = np.zeros(dim, dtype=np.float32)
    for i, v in enumerate(values):
        out[i] = v
    return out


# --- prompt construction ---------------------------------------------------

def test_prompt_includes_identity_constraints():
    prompt = enhance.build_prompt("natural")
    lowered = prompt.lower()
    assert "same person" in lowered
    assert "aspect ratio" in lowered
    assert "do not slim" in lowered or "do not slim, reshape" in lowered


def test_unknown_style_falls_back_to_the_default():
    assert enhance.build_prompt("nonsense") == enhance.build_prompt(enhance.DEFAULT_STYLE)


def test_every_style_is_buildable():
    for style in enhance.STYLES:
        assert len(enhance.build_prompt(style)) > 200


# --- identity similarity ---------------------------------------------------

def test_identical_embeddings_score_one():
    face = FakeFace(_vec(1.0))
    app = FakeFaceApp([face], [face])
    score, count = enhance.identity_similarity(app, _jpeg(), _jpeg())
    assert score == pytest.approx(1.0, abs=1e-5)
    assert count == 1


def test_orthogonal_embeddings_score_zero():
    app = FakeFaceApp([FakeFace(_vec(1.0))], [FakeFace(_vec(0.0, 1.0))])
    score, _ = enhance.identity_similarity(app, _jpeg(), _jpeg())
    assert score == pytest.approx(0.0, abs=1e-5)


def test_no_face_app_is_unverifiable_not_failed():
    assert enhance.identity_similarity(None, _jpeg(), _jpeg()) == (None, 0)


def test_no_face_in_original_is_unverifiable():
    score, count = enhance.identity_similarity(FakeFaceApp([], []), _jpeg(), _jpeg())
    assert score is None and count == 0


def test_face_lost_during_the_edit_scores_zero():
    app = FakeFaceApp([FakeFace(_vec(1.0))], [])
    score, count = enhance.identity_similarity(app, _jpeg(), _jpeg())
    assert score == 0.0 and count == 1


def test_weakest_face_determines_the_score():
    """A two-person photo where only one face drifts must still be caught."""
    before = [FakeFace(_vec(1.0), (0, 0, 50, 50)), FakeFace(_vec(0.0, 1.0), (60, 0, 100, 50))]
    after = [FakeFace(_vec(1.0), (0, 0, 50, 50)), FakeFace(_vec(0.0, 0.3, 0.95), (60, 0, 100, 50))]
    score, count = enhance.identity_similarity(FakeFaceApp(before, after), _jpeg(), _jpeg())
    assert count == 2
    assert score == pytest.approx(0.3, abs=0.02)  # the drifted face, not the intact one


def test_detector_failure_is_swallowed():
    class Exploding:
        def get(self, _):
            raise RuntimeError("onnx blew up")

    assert enhance.identity_similarity(Exploding(), _jpeg(), _jpeg()) == (None, 0)


# --- enhance_photo end to end (mocked model) -------------------------------

@pytest.fixture
def stub_edit(monkeypatch):
    def _install(returned=None, cost=0.05):
        payload = returned if returned is not None else _jpeg("blue")
        monkeypatch.setattr(openrouter, "edit_image",
                            lambda *a, **k: (payload, cost))
        monkeypatch.setattr(openrouter, "image_model", lambda: "test/model")
    return _install


def test_enhance_returns_the_edited_image(stub_edit):
    stub_edit()
    out = enhance.enhance_photo(_jpeg(), face_app=None)
    assert out.image_bytes == _jpeg("blue")
    assert out.cost_usd == pytest.approx(0.05)
    assert out.model == "test/model"
    assert out.style == "natural"


def test_enhance_without_faces_warns_but_succeeds(stub_edit):
    stub_edit()
    out = enhance.enhance_photo(_jpeg(), face_app=FakeFaceApp([], []))
    assert out.identity_score is None
    assert "identity check was skipped" in (out.warning or "")


def test_enhance_passes_a_good_identity_match(stub_edit):
    stub_edit()
    face = FakeFace(_vec(1.0))
    out = enhance.enhance_photo(_jpeg(), face_app=FakeFaceApp([face], [face]))
    assert out.identity_score == pytest.approx(1.0, abs=1e-5)
    assert out.warning is None


def test_enhance_warns_on_a_borderline_match(stub_edit):
    stub_edit()
    # cos ~= 0.55, between REJECT (0.45) and WARN (0.65)
    before = [FakeFace(_vec(1.0))]
    after = [FakeFace(_vec(0.55, 0.835))]
    out = enhance.enhance_photo(_jpeg(), face_app=FakeFaceApp(before, after))
    assert enhance.IDENTITY_REJECT < (out.identity_score or 0) < enhance.IDENTITY_WARN
    assert "drifted" in (out.warning or "")


def test_enhance_rejects_a_different_person(stub_edit):
    stub_edit()
    before = [FakeFace(_vec(1.0))]
    after = [FakeFace(_vec(0.0, 1.0))]
    with pytest.raises(openrouter.OpenRouterError, match="no longer matched"):
        enhance.enhance_photo(_jpeg(), face_app=FakeFaceApp(before, after))


def test_reject_threshold_is_below_the_warn_threshold():
    assert 0 < enhance.IDENTITY_REJECT < enhance.IDENTITY_WARN < 1


# --- openrouter client -----------------------------------------------------

def test_prepare_image_downscales_and_returns_a_data_url():
    url, size = openrouter.prepare_image(_jpeg(size=(4000, 3000)))
    assert url.startswith("data:image/jpeg;base64,")
    assert max(size) == openrouter.MAX_UPLOAD_EDGE


def test_prepare_image_leaves_small_photos_alone():
    _, size = openrouter.prepare_image(_jpeg(size=(320, 240)))
    assert size == (320, 240)


def test_unconfigured_client_raises_a_clear_error(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    assert not openrouter.is_configured()
    with pytest.raises(openrouter.OpenRouterError, match="OPENROUTER_API_KEY"):
        openrouter.edit_image(_jpeg(), "retouch")


def test_image_model_is_overridable(monkeypatch):
    monkeypatch.setenv("OPENROUTER_IMAGE_MODEL", "some/other-model")
    assert openrouter.image_model() == "some/other-model"


def test_default_image_model_can_actually_edit():
    """A text-to-image default would silently replace the user's photo."""
    assert openrouter.can_edit_images(openrouter.DEFAULT_IMAGE_MODEL)
    assert openrouter.DEFAULT_IMAGE_MODEL not in openrouter.MODELS_WITHOUT_EDITING


def test_text_to_image_models_are_refused_for_editing():
    for model in openrouter.MODELS_WITHOUT_EDITING:
        assert not openrouter.can_edit_images(model)


def test_flare_is_rejected_with_an_actionable_message(monkeypatch):
    """It is served only on /images, which ignores the input photo entirely."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setenv("OPENROUTER_IMAGE_MODEL", "openai/gpt-image-2.5-flare")
    with pytest.raises(openrouter.OpenRouterError) as excinfo:
        openrouter.edit_image(_jpeg(), "retouch")
    message = str(excinfo.value)
    assert "text-to-image" in message
    assert openrouter.DEFAULT_IMAGE_MODEL in message


def test_generate_image_decodes_b64_json(monkeypatch):
    raw = _jpeg("red")
    import base64

    _patch_post(monkeypatch, {"data": [{"b64_json": base64.b64encode(raw).decode()}]})
    assert openrouter.generate_image("a red square") == raw


def _fake_response(payload, status=200):
    class R:
        status_code = status
        text = "error body"

        def json(self):
            return payload

    return R()


def _patch_post(monkeypatch, payload, status=200):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")

    class FakeClient:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, *a, **k):
            return _fake_response(payload, status)

    monkeypatch.setattr(openrouter.httpx, "Client", lambda **k: FakeClient())


def test_edit_image_decodes_the_returned_data_url(monkeypatch):
    import base64

    raw = _jpeg("green")
    url = "data:image/png;base64," + base64.b64encode(raw).decode()
    _patch_post(monkeypatch, {
        "choices": [{"message": {"images": [{"image_url": {"url": url}}]}}],
        "usage": {"cost": 0.068},
    })
    out, cost = openrouter.edit_image(_jpeg(), "retouch")
    assert out == raw
    assert cost == pytest.approx(0.068)


def test_edit_image_surfaces_a_refusal(monkeypatch):
    _patch_post(monkeypatch, {"choices": [{"message": {"refusal": "not allowed"}}]})
    with pytest.raises(openrouter.OpenRouterError, match="declined"):
        openrouter.edit_image(_jpeg(), "retouch")


def test_edit_image_errors_when_no_image_comes_back(monkeypatch):
    _patch_post(monkeypatch, {"choices": [{"message": {"content": "I cannot do that"}}]})
    with pytest.raises(openrouter.OpenRouterError, match="no image"):
        openrouter.edit_image(_jpeg(), "retouch")


def test_edit_image_reports_an_http_error(monkeypatch):
    _patch_post(monkeypatch, {}, status=429)
    with pytest.raises(openrouter.OpenRouterError, match="429"):
        openrouter.edit_image(_jpeg(), "retouch")
