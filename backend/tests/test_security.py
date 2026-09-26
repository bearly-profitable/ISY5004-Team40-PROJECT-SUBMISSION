"""Security regression tests: access control, path handling, upload validation,
input limits and rate limiting. Same environment needs as test_api.py."""
import io
import json

import pytest

pytest.importorskip("torch")
pytest.importorskip("mediapipe")
pytest.importorskip("fastapi")

from tests.test_api import OWNER, TINY_JPEG, _start_and_finish_job, client  # noqa: E402,F401

ATTACKER = {"X-Client-Id": "attacker-browser"}


def _upload(test_client, files, meta, headers=OWNER):
    return test_client.post("/api/analyze", headers=headers, files=files,
                            data={"photoMeta": json.dumps(meta)})


def test_client_id_cannot_pose_as_a_signed_in_account(client):
    test_client, _ = client
    forged = {"X-Client-Id": "user:00000000-0000-4000-8000-000000000000"}
    assert test_client.get("/api/preferences", headers=forged).status_code == 400
    assert test_client.get("/api/sessions", headers={"X-Client-Id": "' OR 1=1 --"}).status_code == 400


@pytest.mark.parametrize("method,path,body", [
    ("GET", "/api/analyze/{job}", None),
    ("GET", "/api/sessions/{job}", None),
    ("DELETE", "/api/sessions/{job}", None),
    ("POST", "/api/corrections/{job}", {"action": "delete_event", "eventId": "event_0"}),
    ("POST", "/api/export/{job}", {"photoIds": ["photo-a"]}),
    ("POST", "/api/collage/{job}", {"photoIds": ["photo-a"]}),
    ("POST", "/api/rescore/{job}", None),
    ("POST", "/api/search/{job}", {"query": "beach"}),
    ("DELETE", "/api/enhanced/{job}/photo-a", None),
])
def test_other_browsers_cannot_touch_a_session(client, method, path, body):
    test_client, _ = client
    job_id = _start_and_finish_job(client)
    resp = test_client.request(method, path.format(job=job_id), headers=ATTACKER, json=body)
    assert resp.status_code == 404
    # ...and the owner still can see it afterwards.
    assert test_client.get(f"/api/sessions/{job_id}").status_code == 200


def test_attacker_cannot_start_paid_enhancement(client, monkeypatch):
    test_client, server = client
    job_id = _start_and_finish_job(client)
    monkeypatch.setattr(server.openrouter, "is_configured", lambda: True)
    resp = test_client.post("/api/enhance", headers=ATTACKER,
                            json={"jobId": job_id, "photoId": "photo-a"})
    assert resp.status_code == 404


def test_feedback_on_someone_elses_session_is_refused(client):
    test_client, _ = client
    job_id = _start_and_finish_job(client)
    resp = test_client.post("/api/feedback", headers=ATTACKER, json={
        "jobId": job_id, "eventId": "event_0",
        "winnerPhotoId": "photo-b", "loserPhotoId": "photo-a",
    })
    assert resp.status_code == 404


@pytest.mark.parametrize("job_id", ["..", "C:%5CWindows", "..%5C..%5Cetc", "nope"])
def test_job_ids_that_are_not_uuids_never_reach_the_disk(client, job_id):
    test_client, _ = client
    assert test_client.get(f"/api/enhanced/{job_id}/probe").status_code == 404
    assert test_client.delete(f"/api/enhanced/{job_id}/probe").status_code == 404
    assert test_client.get(f"/api/photos/{job_id}/probe").status_code == 404


def test_non_images_are_rejected(client):
    test_client, server = client
    before = set(server.JOBS_DIR.iterdir())
    resp = _upload(test_client, [("files", ("evil.html", io.BytesIO(b"<script>alert(1)</script>"), "text/html"))],
                   [{"id": "x", "name": "evil.html"}])
    assert resp.status_code == 400
    assert set(server.JOBS_DIR.iterdir()) == before  # nothing left behind


def test_stored_extension_comes_from_the_image_not_the_filename(client):
    test_client, server = client
    resp = _upload(test_client, [("files", ("photo.html", io.BytesIO(TINY_JPEG), "text/html"))],
                   [{"id": "p", "name": "photo.html"}])
    assert resp.status_code == 200
    stored = list((server.JOBS_DIR / resp.json()["jobId"] / "input").iterdir())
    assert [f.suffix for f in stored] == [".jpg"]


def test_oversized_uploads_are_rejected(client, monkeypatch):
    test_client, server = client
    monkeypatch.setattr(server, "MAX_UPLOAD_MB", 0.001)
    resp = _upload(test_client, [("files", ("big.jpg", io.BytesIO(TINY_JPEG * 3), "image/jpeg"))],
                   [{"id": "big", "name": "big.jpg"}])
    assert resp.status_code == 413


def test_uploads_need_an_owner(client):
    test_client, _ = client
    resp = _upload(test_client, [("files", ("a.jpg", io.BytesIO(TINY_JPEG), "image/jpeg"))],
                   [{"id": "a", "name": "a.jpg"}], headers={"X-Client-Id": ""})
    assert resp.status_code == 400


def test_oversized_text_fields_are_rejected(client):
    test_client, _ = client
    job_id = _start_and_finish_job(client)
    assert test_client.post(f"/api/search/{job_id}", json={"query": "a" * 10_000}).status_code == 422
    assert test_client.post(f"/api/corrections/{job_id}", json={
        "action": "rename_event", "eventId": "event_0", "label": "x" * 10_000}).status_code == 422


def test_non_finite_weights_are_rejected(client):
    test_client, server = client
    weights = {k: 1.0 for k in server.DEFAULT_WEIGHTS}
    body = json.dumps({"weights": weights}).replace("1.0", "Infinity", 1)
    resp = test_client.put("/api/preferences", content=body, headers={"Content-Type": "application/json"})
    assert resp.status_code in (400, 422)


def test_face_analysis_is_rate_limited(client, monkeypatch):
    test_client, server = client
    monkeypatch.setattr(server, "RATE_FACE_PER_MINUTE", 3)
    monkeypatch.setattr(server.face_analyzer, "analyze", lambda path: {"faces": []})
    codes = [test_client.post("/api/face-analysis", headers={"X-Client-Id": "face-burst"},
                              files={"file": ("f.jpg", io.BytesIO(TINY_JPEG), "image/jpeg")}).status_code
             for _ in range(5)]
    assert codes[:3] == [200, 200, 200]
    assert codes[3:] == [429, 429]


def test_hardening_headers_and_no_public_docs(client):
    test_client, _ = client
    headers = test_client.get("/api/health").headers
    assert headers["x-content-type-options"] == "nosniff"
    assert headers["x-frame-options"] == "DENY"
    assert "frame-ancestors 'none'" in headers["content-security-policy"]
    assert test_client.get("/openapi.json").status_code == 404
    assert test_client.get("/docs").status_code == 404


def test_cors_rejects_foreign_origins_and_credentials(client):
    test_client, _ = client
    evil = test_client.options("/api/sessions", headers={
        "Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in evil.headers
    local = test_client.options("/api/sessions", headers={
        "Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"})
    assert local.headers.get("access-control-allow-credentials") != "true"
