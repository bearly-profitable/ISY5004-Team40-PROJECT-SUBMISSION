"""API integration tests with the ML pipeline mocked out.

These need the full backend environment (torch, mediapipe, fastapi) so they
are skipped automatically where those aren't installed (e.g. the lightweight
CI unit-test job); run them locally with `pytest backend/tests`.
"""
import importlib
import io
import json
import os
import sys
import time
import zipfile

import pytest

pytest.importorskip("torch")
pytest.importorskip("mediapipe")
pytest.importorskip("fastapi")

from fastapi.testclient import TestClient  # noqa: E402


CANNED_RESULT = {
    "summary": {"numPhotos": 2, "numEvents": 1, "numIdentities": 1,
                "cacheHits": 0, "cacheMisses": 2},
    "events": [
        {
            "id": "event_0",
            "label": "Beach",
            "autoLabel": {"label": "Beach", "confidence": 0.31},
            "photoIds": ["photo-a", "photo-b"],
            "topPhotoId": "photo-a",
            "persons": ["person_0"],
            "members": [
                {"photoId": "photo-a", "finalScore": 0.9,
                 "normSignals": {s: 0.9 for s in
                                 ["centrality", "nimaScore", "faceSharpness", "faceSize",
                                  "detScore", "poseQuality", "ear"]},
                 "explanation": {"summary": "Selected", "reasons": []}},
                {"photoId": "photo-b", "finalScore": 0.4,
                 "normSignals": {s: 0.4 for s in
                                 ["centrality", "nimaScore", "faceSharpness", "faceSize",
                                  "detScore", "poseQuality", "ear"]},
                 "explanation": {"summary": "Ranked #2", "reasons": []}},
            ],
            "bestByPerson": [{"personId": "person_0", "photoId": "photo-a"}],
            "mmrPicks": {},
        }
    ],
    "identities": [
        {"id": "person_0", "label": "Person 1", "faceThumb": None,
         "photoIds": ["photo-a", "photo-b"], "eventIds": ["event_0"]},
    ],
}

def _tiny_jpeg() -> bytes:
    from PIL import Image as PILImage

    buf = io.BytesIO()
    PILImage.new("RGB", (32, 32), "white").save(buf, format="JPEG")
    return buf.getvalue()


TINY_JPEG = _tiny_jpeg()
OWNER = {"X-Client-Id": "tester-default"}


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("lumina_api")
    os.environ["LUMINA_DB_PATH"] = str(tmp / "test.db")
    os.environ["LUMINA_JOBS_DIR"] = str(tmp / "jobs")
    os.environ.pop("LUMINA_API_KEY", None)
    os.environ["RATE_ANALYZE_PER_HOUR"] = "1000"

    # Force a clean import so the env vars take effect
    sys.modules.pop("server", None)
    server = importlib.import_module("server")

    server.pipeline._load_models = lambda: None
    server.pipeline.run = lambda image_paths, photo_ids, callback=None: json.loads(json.dumps(CANNED_RESULT))

    # Every session has an owner: this is the browser the tests act as.
    with TestClient(server.app, headers=OWNER) as test_client:
        yield test_client, server


def _start_and_finish_job(client_and_server, headers=OWNER):
    test_client, server = client_and_server
    files = [
        ("files", ("a.jpg", io.BytesIO(TINY_JPEG), "image/jpeg")),
        ("files", ("b.jpg", io.BytesIO(TINY_JPEG), "image/jpeg")),
    ]
    meta = json.dumps([
        {"id": "photo-a", "name": "a.jpg", "size": "1 KB"},
        {"id": "photo-b", "name": "b.jpg", "size": "1 KB"},
    ])
    resp = test_client.post("/api/analyze", headers=headers, files=files, data={"photoMeta": meta})
    assert resp.status_code == 200
    job_id = resp.json()["jobId"]
    server.job_queue.join()  # wait for the single worker to finish
    return job_id


def test_health(client):
    test_client, _ = client
    assert test_client.get("/api/health").json() == {"status": "ok"}


def test_analyze_roundtrip_and_persistence(client):
    test_client, server = client
    job_id = _start_and_finish_job(client)

    status = test_client.get(f"/api/analyze/{job_id}").json()
    assert status["status"] == "completed"
    assert status["result"]["summary"]["numEvents"] == 1

    # Durable: survives loss of the in-memory mirror
    with server.job_lock:
        server.job_store.pop(job_id)
    status2 = test_client.get(f"/api/analyze/{job_id}").json()
    assert status2["status"] == "completed"

    # Session listing + retrieval
    sessions = test_client.get("/api/sessions").json()["sessions"]
    assert any(s["jobId"] == job_id for s in sessions)
    session = test_client.get(f"/api/sessions/{job_id}").json()
    assert {p["id"] for p in session["photos"]} == {"photo-a", "photo-b"}

    # Stored photos are served back
    photo = test_client.get(f"/api/photos/{job_id}/photo-a")
    assert photo.status_code == 200
    assert photo.headers["content-type"] == "image/jpeg"


def test_feedback_updates_preferences_and_pins_best(client):
    test_client, _ = client
    headers = {"X-Client-Id": "tester-1"}
    job_id = _start_and_finish_job(client, headers)

    resp = test_client.post("/api/feedback", headers=headers, json={
        "jobId": job_id, "eventId": "event_0",
        "winnerPhotoId": "photo-b", "loserPhotoId": "photo-a",
    })
    assert resp.status_code == 200
    assert resp.json()["nUpdates"] == 1

    session = test_client.get(f"/api/sessions/{job_id}", headers=headers).json()
    evt = session["result"]["events"][0]
    assert evt["topPhotoId"] == "photo-b"
    assert evt["userPinned"] is True

    prefs = test_client.get("/api/preferences", headers=headers).json()
    assert prefs["nUpdates"] == 1
    assert prefs["feedbackCount"] == 1

    rescore = test_client.post(f"/api/rescore/{job_id}", headers=headers).json()
    assert rescore["events"][0]["ranking"]

    reset = test_client.post("/api/preferences/reset", headers=headers).json()
    assert reset["nUpdates"] == 0


def test_feedback_requires_client_id(client):
    test_client, _ = client
    resp = test_client.post("/api/feedback", headers={"X-Client-Id": ""}, json={
        "jobId": "x", "eventId": "e", "winnerPhotoId": "a", "loserPhotoId": "b",
    })
    assert resp.status_code == 400


def test_corrections_endpoint(client):
    test_client, _ = client
    job_id = _start_and_finish_job(client)

    resp = test_client.post(f"/api/corrections/{job_id}", json={
        "action": "rename_person", "personId": "person_0", "label": "Alice",
    })
    assert resp.status_code == 200
    assert resp.json()["result"]["identities"][0]["label"] == "Alice"

    bad = test_client.post(f"/api/corrections/{job_id}", json={
        "action": "merge_persons", "personId": "person_0", "targetPersonId": "person_0",
    })
    assert bad.status_code == 400


def test_delete_photos_endpoint(client):
    test_client, server = client
    job_id = _start_and_finish_job(client)
    assert test_client.get(f"/api/photos/{job_id}/photo-b?w=200").status_code == 200

    resp = test_client.post(f"/api/sessions/{job_id}/delete-photos", json={"photoIds": ["photo-b"]})
    assert resp.status_code == 200
    assert resp.json()["result"]["events"][0]["photoIds"] == ["photo-a"]

    # Gone from the stored session, photo serving, and disk
    session = test_client.get(f"/api/sessions/{job_id}").json()
    assert {p["id"] for p in session["photos"]} == {"photo-a"}
    assert test_client.get(f"/api/photos/{job_id}/photo-b").status_code == 404
    assert not list((server.JOBS_DIR / job_id / "thumbs").glob("*_b*"))

    assert test_client.post(f"/api/sessions/{job_id}/delete-photos", json={"photoIds": ["photo-b"]}).status_code == 400


def test_export_returns_zip(client):
    test_client, _ = client
    job_id = _start_and_finish_job(client)

    resp = test_client.post(f"/api/export/{job_id}", json={
        "photoIds": ["photo-a"], "albumName": "My Best Shots",
    })
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/zip"
    zf = zipfile.ZipFile(io.BytesIO(resp.content))
    assert zf.namelist() == ["a.jpg"]


def test_delete_session_removes_everything(client):
    test_client, server = client
    job_id = _start_and_finish_job(client)
    job_dir = server.JOBS_DIR / job_id
    assert job_dir.exists()

    resp = test_client.delete(f"/api/sessions/{job_id}")
    assert resp.status_code == 200

    # Gone from listings, status lookups, photo serving, and disk
    assert all(s["jobId"] != job_id for s in test_client.get("/api/sessions").json()["sessions"])
    assert test_client.get(f"/api/analyze/{job_id}").status_code == 404
    assert test_client.get(f"/api/photos/{job_id}/photo-a").status_code == 404
    assert not job_dir.exists()

    # Idempotence: second delete is a clean 404
    assert test_client.delete(f"/api/sessions/{job_id}").status_code == 404


def test_photo_thumbnail_endpoint(client):
    test_client, _ = client
    job_id = _start_and_finish_job(client)

    thumb = test_client.get(f"/api/photos/{job_id}/photo-a?w=200")
    assert thumb.status_code == 200
    assert thumb.headers["content-type"] == "image/jpeg"

    bad = test_client.get(f"/api/photos/{job_id}/photo-a?w=123")
    assert bad.status_code == 400


def test_sse_stream_ends_with_terminal_frame(client):
    test_client, _ = client
    job_id = _start_and_finish_job(client)

    with test_client.stream("GET", f"/api/analyze/{job_id}/stream") as resp:
        assert resp.status_code == 200
        body = "".join(chunk for chunk in resp.iter_text())
    frames = [json.loads(line[6:]) for line in body.splitlines() if line.startswith("data: ")]
    assert frames
    assert frames[-1]["status"] == "completed"
    # The stream is unauthenticated, so the result is fetched separately.
    assert all("result" not in frame for frame in frames)

    missing = test_client.get("/api/analyze/nonexistent/stream")
    assert missing.status_code == 404


def test_search_without_index_404s(client):
    test_client, _ = client
    job_id = _start_and_finish_job(client)
    resp = test_client.post(f"/api/search/{job_id}", json={"query": "beach"})
    # The mocked pipeline produced no CLIP index for this job
    assert resp.status_code in (404, 503)


# ---------------------------------------------------------------------------
# AI enhancement + PDF collage endpoints (OpenRouter always mocked)
# ---------------------------------------------------------------------------

def _enhanced_jpeg() -> bytes:
    from PIL import Image as PILImage

    buf = io.BytesIO()
    PILImage.new("RGB", (32, 32), "navy").save(buf, format="JPEG")
    return buf.getvalue()


def test_collage_themes_endpoint(client):
    test_client, _ = client
    payload = test_client.get("/api/collage/themes").json()
    keys = [t["key"] for t in payload["themes"]]
    assert payload["default"] in keys
    assert len(keys) >= 3
    for theme in payload["themes"]:
        assert len(theme["swatch"]) == 3
        assert all(s.startswith("#") for s in theme["swatch"])


def test_collage_returns_a_pdf(client):
    test_client, _ = client
    job_id = _start_and_finish_job(client)
    resp = test_client.post(f"/api/collage/{job_id}",
                            json={"photoIds": ["photo-a", "photo-b"], "title": "Trip"})
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/pdf"
    assert "Trip.pdf" in resp.headers["content-disposition"]
    assert resp.content.startswith(b"%PDF")


def test_collage_rejects_an_empty_selection(client):
    test_client, _ = client
    job_id = _start_and_finish_job(client)
    assert test_client.post(f"/api/collage/{job_id}", json={"photoIds": []}).status_code == 400


def test_collage_404s_for_unknown_job_and_photos(client):
    test_client, _ = client
    job_id = _start_and_finish_job(client)
    assert test_client.post("/api/collage/nope", json={"photoIds": ["photo-a"]}).status_code == 404
    assert test_client.post(f"/api/collage/{job_id}",
                            json={"photoIds": ["ghost"]}).status_code == 404


def test_enhance_requires_configuration(client, monkeypatch):
    test_client, server = client
    job_id = _start_and_finish_job(client)
    monkeypatch.setattr(server.openrouter, "is_configured", lambda: False)
    resp = test_client.post("/api/enhance", json={"jobId": job_id, "photoId": "photo-a"})
    assert resp.status_code == 503
    assert "OPENROUTER_API_KEY" in resp.json()["detail"]


def test_enhance_roundtrip_stores_and_serves_the_edit(client, monkeypatch):
    test_client, server = client
    job_id = _start_and_finish_job(client)

    monkeypatch.setattr(server.openrouter, "is_configured", lambda: True)
    monkeypatch.setattr(server.enhance_mod, "enhance_photo",
                        lambda original, face_app=None, style="natural":
                        server.enhance_mod.EnhanceOutcome(
                            image_bytes=_enhanced_jpeg(), identity_score=None, num_faces=0,
                            warning=None, cost_usd=0.07, model="test/model", style=style))

    enhance_id = test_client.post(
        "/api/enhance", json={"jobId": job_id, "photoId": "photo-a"}
    ).json()["enhanceId"]

    for _ in range(100):
        status = test_client.get(f"/api/enhance/{enhance_id}").json()
        if status["status"] in ("completed", "failed"):
            break
        time.sleep(0.05)

    assert status["status"] == "completed", status.get("error")
    assert status["costUsd"] == pytest.approx(0.07)
    assert status["url"] == f"/api/enhanced/{job_id}/photo-a"

    served = test_client.get(f"/api/enhanced/{job_id}/photo-a")
    assert served.status_code == 200
    assert served.headers["content-type"] == "image/jpeg"

    # A reopened session reports the enhancement...
    session = test_client.get(f"/api/sessions/{job_id}").json()
    assert "photo-a" in session["enhancedPhotoIds"]

    # ...the collage can use it...
    assert test_client.post(f"/api/collage/{job_id}",
                            json={"photoIds": ["photo-a"], "useEnhanced": True}
                            ).status_code == 200

    # ...and reverting removes it.
    assert test_client.delete(f"/api/enhanced/{job_id}/photo-a").status_code == 200
    assert test_client.get(f"/api/enhanced/{job_id}/photo-a").status_code == 404
    assert "photo-a" not in test_client.get(f"/api/sessions/{job_id}").json()["enhancedPhotoIds"]


def test_enhance_failure_is_reported_not_raised(client, monkeypatch):
    test_client, server = client
    job_id = _start_and_finish_job(client)

    monkeypatch.setattr(server.openrouter, "is_configured", lambda: True)

    def boom(*args, **kwargs):
        raise server.openrouter.OpenRouterError("model said no")

    monkeypatch.setattr(server.enhance_mod, "enhance_photo", boom)
    enhance_id = test_client.post(
        "/api/enhance", json={"jobId": job_id, "photoId": "photo-b"}
    ).json()["enhanceId"]

    for _ in range(100):
        status = test_client.get(f"/api/enhance/{enhance_id}").json()
        if status["status"] in ("completed", "failed"):
            break
        time.sleep(0.05)

    assert status["status"] == "failed"
    assert "model said no" in status["error"]


def test_enhance_404s_for_unknown_ids(client, monkeypatch):
    test_client, server = client
    job_id = _start_and_finish_job(client)
    monkeypatch.setattr(server.openrouter, "is_configured", lambda: True)
    assert test_client.get("/api/enhance/not-a-real-id").status_code == 404
    assert test_client.post("/api/enhance",
                            json={"jobId": job_id, "photoId": "ghost"}).status_code == 404
    assert test_client.post("/api/enhance",
                            json={"jobId": "nope", "photoId": "photo-a"}).status_code == 404


def _as_user(server, monkeypatch, tokens):
    """Pretend Supabase is configured and accepts `tokens` (token -> user id)."""
    import auth
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "anon")

    def fake_verify(token):
        if token not in tokens:
            from fastapi import HTTPException
            raise HTTPException(status_code=401, detail="bad token")
        return tokens[token]

    monkeypatch.setattr(auth, "_verify", fake_verify)


def test_signed_in_sessions_are_private_and_claimable(client, monkeypatch):
    test_client, server = client
    _as_user(server, monkeypatch, {"tok-1": "u1", "tok-2": "u2"})
    browser = {"X-Client-Id": "browser-claim"}
    u1 = {**browser, "Authorization": "Bearer tok-1"}
    u2 = {"X-Client-Id": "other", "Authorization": "Bearer tok-2"}

    # Made while signed out on this browser ...
    files = [("files", ("a.jpg", io.BytesIO(TINY_JPEG), "image/jpeg"))]
    meta = json.dumps([{"id": "photo-a", "name": "a.jpg", "size": "1 KB"}])
    job_id = test_client.post("/api/analyze", headers=browser, files=files,
                              data={"photoMeta": meta}).json()["jobId"]
    server.job_queue.join()
    assert all(s["jobId"] != job_id for s in test_client.get("/api/sessions", headers=u1).json()["sessions"])

    # ... then claimed by the account that signs in there.
    assert test_client.post("/api/account/claim", headers=u1).json()["sessions"] == 1
    listing = test_client.get("/api/sessions", headers=u1).json()
    assert listing["signedIn"] is True
    assert any(s["jobId"] == job_id for s in listing["sessions"])

    # Nobody else sees or deletes it.
    assert all(s["jobId"] != job_id for s in test_client.get("/api/sessions", headers=u2).json()["sessions"])
    assert all(s["jobId"] != job_id for s in test_client.get("/api/sessions").json()["sessions"])
    assert test_client.delete(f"/api/sessions/{job_id}", headers=u2).status_code == 404
    assert test_client.delete(f"/api/sessions/{job_id}", headers=u1).status_code == 200

    assert test_client.get("/api/sessions", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_hand_tuned_weights_are_normalised(client):
    test_client, server = client
    headers = {"X-Client-Id": "tuner"}
    weights = {k: 1.0 for k in server.DEFAULT_WEIGHTS}
    resp = test_client.put("/api/preferences", headers=headers, json={"weights": weights})
    assert resp.status_code == 200
    got = resp.json()["weights"]
    assert abs(sum(got.values()) - 1.0) < 1e-6
    assert abs(got["ear"] - 1 / len(weights)) < 1e-6
    assert test_client.get("/api/preferences", headers=headers).json()["weights"] == got

    bad = test_client.put("/api/preferences", headers=headers, json={"weights": {"ear": 1.0}})
    assert bad.status_code == 400
