import numpy as np
import pytest

from store import LuminaStore


@pytest.fixture()
def store(tmp_path):
    return LuminaStore(tmp_path / "test.db")


def test_job_lifecycle(store):
    store.create_job("job1", num_photos=3, photo_map={"a": "0000_a.jpg"})
    job = store.get_job("job1")
    assert job["status"] == "queued"
    assert job["numPhotos"] == 3

    store.update_job("job1", status="running", progress=40, step_key="analyzing")
    assert store.get_job("job1")["progress"] == 40

    result = {"summary": {"numPhotos": 3}, "events": [], "identities": []}
    store.update_job("job1", status="completed", result=result)
    assert store.get_job("job1")["result"] == result
    assert store.get_result("job1") == result
    assert store.get_photo_map("job1") == {"a": "0000_a.jpg"}


def test_list_sessions_only_completed(store):
    store.create_job("done", 1, {})
    store.update_job("done", status="completed", result={"summary": {"n": 1}, "events": []})
    store.create_job("pending", 1, {})

    sessions = store.list_sessions()
    assert [s["jobId"] for s in sessions] == ["done"]
    assert sessions[0]["summary"] == {"n": 1}


def test_mark_interrupted_jobs_failed(store):
    store.create_job("a", 1, {})
    store.update_job("a", status="running")
    store.create_job("b", 1, {})
    store.update_job("b", status="completed", result={})
    assert store.mark_interrupted_jobs_failed() == 1
    assert store.get_job("a")["status"] == "failed"
    assert store.get_job("b")["status"] == "completed"


def test_delete_jobs_older_than(store):
    store.create_job("old", 1, {})
    # Backdate the row
    with store._conn() as conn:
        conn.execute("UPDATE jobs SET created_at = created_at - 100000 WHERE job_id = 'old'")
    store.create_job("new", 1, {})

    deleted = store.delete_jobs_older_than(50000)
    assert deleted == ["old"]
    assert store.get_job("old") is None
    assert store.get_job("new") is not None


def test_feedback_and_preferences(store):
    store.add_feedback("client1", "job1", "event_0", "winner", "loser")
    assert store.count_feedback("client1") == 1
    assert store.count_feedback("client2") == 0

    assert store.get_preferences("client1") is None
    store.save_preferences("client1", {"weights": {"a": 1.0}, "n_updates": 3})
    assert store.get_preferences("client1")["n_updates"] == 3
    # Upsert
    store.save_preferences("client1", {"weights": {"a": 0.5}, "n_updates": 4})
    assert store.get_preferences("client1")["n_updates"] == 4


def test_embedding_cache_roundtrip(store):
    entry = {
        "dino": np.arange(8, dtype=np.float32),
        "faces": [{"embedding": np.ones(4, dtype=np.float32), "det_score": 0.9}],
        "nima": 5.5,
    }
    store.cache_put("hash1:v2", entry)
    out = store.cache_get("hash1:v2")
    np.testing.assert_array_equal(out["dino"], entry["dino"])
    assert out["nima"] == 5.5
    assert store.cache_get("missing") is None

    stats = store.cache_stats()
    assert stats["entries"] == 1
    assert stats["bytes"] > 0


def test_cache_prune_keeps_newest(store):
    for i in range(10):
        store.cache_put(f"h{i}", {"i": i})
        with store._conn() as conn:
            conn.execute("UPDATE embed_cache SET created_at = ? WHERE image_hash = ?", (float(i), f"h{i}"))
    removed = store.cache_prune(max_entries=3)
    assert removed == 7
    assert store.cache_get("h9") is not None
    assert store.cache_get("h0") is None


def test_corrections_log(store):
    store.add_correction("job1", "merge_persons", {"personId": "a", "targetPersonId": "b"})
    with store._conn() as conn:
        rows = conn.execute("SELECT * FROM corrections").fetchall()
    assert len(rows) == 1
    assert rows[0]["action"] == "merge_persons"


def test_sessions_are_scoped_to_their_owner(store):
    for job_id, owner in [("mine", "user:1"), ("theirs", "user:2"), ("legacy", None), ("anon", "browser-a")]:
        store.create_job(job_id, 1, {}, owner=owner)
        store.update_job(job_id, status="completed", result={"events": []})

    assert [s["jobId"] for s in store.list_sessions(owner="user:1")] == ["mine"]
    assert {s["jobId"] for s in store.list_sessions(owner="browser-a", include_legacy=True)} == {"anon", "legacy"}
    assert [s["jobId"] for s in store.list_sessions(owner=None)] == ["legacy"]
    assert len(store.list_sessions()) == 4
    assert store.job_owner("mine") == (True, "user:1")
    assert store.job_owner("ghost") == (False, None)


def test_claim_moves_anonymous_work_into_the_account(store):
    store.create_job("j", 1, {}, owner="browser-a")
    store.add_feedback("browser-a", "j", "e", "w", "l")
    store.save_preferences("browser-a", {"weights": {}, "n_updates": 3})

    moved = store.claim_anonymous("browser-a", "user:1")
    assert moved == {"sessions": 1, "feedback": 1, "preferences": 1}
    assert store.job_owner("j") == (True, "user:1")
    assert store.count_feedback("user:1") == 1
    assert store.get_preferences("user:1")["n_updates"] == 3

    # An account's own taste is never overwritten by a later claim.
    store.save_preferences("browser-b", {"weights": {}, "n_updates": 9})
    assert store.claim_anonymous("browser-b", "user:1")["preferences"] == 0
    assert store.get_preferences("user:1")["n_updates"] == 3


def test_signed_in_sessions_outlive_anonymous_ones(store):
    store.create_job("anon", 1, {}, owner="browser-a")
    store.create_job("user", 1, {}, owner="user:1")
    with store._conn() as conn:
        conn.execute("UPDATE jobs SET created_at = created_at - 100000")

    assert store.delete_jobs_older_than(50000, user_max_age_seconds=500000) == ["anon"]
    assert store.get_job("user") is not None
