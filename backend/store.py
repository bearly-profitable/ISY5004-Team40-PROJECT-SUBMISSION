"""SQLite persistence for Lumina.

Replaces the in-memory job store with durable storage:

- jobs / results          -> sessions survive server restarts, shareable by id
- feedback + preferences  -> pairwise swap events and learned per-user weights
- corrections             -> audit log of human cluster corrections
- embed_cache             -> per-image model outputs keyed by content hash, so
                             re-analysing previously seen photos skips inference

SQLite is deliberate: single-file, zero-ops, and this workload is a handful of
writers at most. WAL mode + short-lived connections keep it safe across the
FastAPI threads and the worker thread.
"""
from __future__ import annotations

import json
import pickle
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    job_id      TEXT PRIMARY KEY,
    created_at  REAL NOT NULL,
    status      TEXT NOT NULL,
    step_key    TEXT NOT NULL DEFAULT 'queued',
    step_label  TEXT NOT NULL DEFAULT 'Queued',
    progress    INTEGER NOT NULL DEFAULT 0,
    error       TEXT,
    num_photos  INTEGER NOT NULL DEFAULT 0,
    result_json TEXT,
    photo_map_json TEXT
);

CREATE TABLE IF NOT EXISTS feedback (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  REAL NOT NULL,
    client_id   TEXT NOT NULL,
    job_id      TEXT NOT NULL,
    event_id    TEXT,
    winner_photo_id TEXT NOT NULL,
    loser_photo_id  TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'swap_best'
);

CREATE TABLE IF NOT EXISTS preferences (
    client_id   TEXT PRIMARY KEY,
    data_json   TEXT NOT NULL,
    updated_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS corrections (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  REAL NOT NULL,
    job_id      TEXT NOT NULL,
    action      TEXT NOT NULL,
    payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS embed_cache (
    image_hash  TEXT NOT NULL,
    kind        TEXT NOT NULL,
    created_at  REAL NOT NULL,
    data        BLOB NOT NULL,
    PRIMARY KEY (image_hash, kind)
);
"""


class LuminaStore:
    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._conn() as conn:
            conn.executescript(_SCHEMA)

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.row_factory = sqlite3.Row
        return conn

    # ------------------------------------------------------------------ jobs
    def create_job(self, job_id: str, num_photos: int, photo_map: Dict[str, str]) -> None:
        with self._conn() as conn:
            conn.execute(
                "INSERT INTO jobs (job_id, created_at, status, num_photos, photo_map_json)"
                " VALUES (?, ?, 'queued', ?, ?)",
                (job_id, time.time(), num_photos, json.dumps(photo_map)),
            )

    def update_job(self, job_id: str, **fields: Any) -> None:
        allowed = {"status", "step_key", "step_label", "progress", "error"}
        sets, vals = [], []
        for key, val in fields.items():
            if key == "result":
                sets.append("result_json = ?")
                vals.append(json.dumps(val) if val is not None else None)
            elif key in allowed:
                sets.append(f"{key} = ?")
                vals.append(val)
        if not sets:
            return
        vals.append(job_id)
        with self._conn() as conn:
            conn.execute(f"UPDATE jobs SET {', '.join(sets)} WHERE job_id = ?", vals)

    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self._conn() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
        return self._job_row_to_dict(row) if row else None

    def list_sessions(self, limit: int = 50) -> List[Dict[str, Any]]:
        """Completed jobs, newest first, without the full result payload."""
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT job_id, created_at, status, num_photos, result_json FROM jobs"
                " WHERE status = 'completed' ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        sessions = []
        for row in rows:
            summary, top_photo_id = None, None
            if row["result_json"]:
                try:
                    result = json.loads(row["result_json"])
                    summary = result.get("summary")
                    events = result.get("events") or []
                    if events:
                        top_photo_id = events[0].get("topPhotoId")
                except json.JSONDecodeError:
                    pass
            sessions.append({
                "jobId": row["job_id"],
                "createdAt": row["created_at"],
                "numPhotos": row["num_photos"],
                "summary": summary,
                "topPhotoId": top_photo_id,
            })
        return sessions

    def save_result(self, job_id: str, result: Dict[str, Any]) -> None:
        self.update_job(job_id, result=result)

    def get_result(self, job_id: str) -> Optional[Dict[str, Any]]:
        job = self.get_job(job_id)
        return job.get("result") if job else None

    def get_photo_map(self, job_id: str) -> Dict[str, str]:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT photo_map_json FROM jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
        if row and row["photo_map_json"]:
            return json.loads(row["photo_map_json"])
        return {}

    def mark_interrupted_jobs_failed(self) -> int:
        """Jobs that were queued/running when the server died can never finish."""
        with self._conn() as conn:
            cur = conn.execute(
                "UPDATE jobs SET status = 'failed', error = 'Server restarted before the job finished.'"
                " WHERE status IN ('queued', 'running')"
            )
            return cur.rowcount

    def delete_job(self, job_id: str) -> bool:
        """Remove one job row plus its per-job search index. Returns whether
        the job existed. (The per-image feature cache is content-addressed
        and shared across jobs, so it is deliberately left alone.)"""
        with self._conn() as conn:
            cur = conn.execute("DELETE FROM jobs WHERE job_id = ?", (job_id,))
            conn.execute(
                "DELETE FROM embed_cache WHERE image_hash = ? AND kind = 'clip_index'",
                (job_id,),
            )
        return cur.rowcount > 0

    def delete_jobs_older_than(self, max_age_seconds: float) -> List[str]:
        cutoff = time.time() - max_age_seconds
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT job_id FROM jobs WHERE created_at < ?", (cutoff,)
            ).fetchall()
            ids = [r["job_id"] for r in rows]
            if ids:
                conn.executemany("DELETE FROM jobs WHERE job_id = ?", [(i,) for i in ids])
        return ids

    @staticmethod
    def _job_row_to_dict(row: sqlite3.Row) -> Dict[str, Any]:
        return {
            "jobId": row["job_id"],
            "createdAt": row["created_at"],
            "status": row["status"],
            "stepKey": row["step_key"],
            "stepLabel": row["step_label"],
            "progress": row["progress"],
            "error": row["error"],
            "numPhotos": row["num_photos"],
            "result": json.loads(row["result_json"]) if row["result_json"] else None,
        }

    # -------------------------------------------------------------- feedback
    def add_feedback(
        self,
        client_id: str,
        job_id: str,
        event_id: Optional[str],
        winner_photo_id: str,
        loser_photo_id: str,
        kind: str = "swap_best",
    ) -> None:
        with self._conn() as conn:
            conn.execute(
                "INSERT INTO feedback (created_at, client_id, job_id, event_id,"
                " winner_photo_id, loser_photo_id, kind) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (time.time(), client_id, job_id, event_id, winner_photo_id, loser_photo_id, kind),
            )

    def count_feedback(self, client_id: str) -> int:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM feedback WHERE client_id = ?", (client_id,)
            ).fetchone()
        return int(row["n"]) if row else 0

    # ----------------------------------------------------------- preferences
    def get_preferences(self, client_id: str) -> Optional[Dict[str, Any]]:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT data_json FROM preferences WHERE client_id = ?", (client_id,)
            ).fetchone()
        return json.loads(row["data_json"]) if row else None

    def save_preferences(self, client_id: str, data: Dict[str, Any]) -> None:
        with self._conn() as conn:
            conn.execute(
                "INSERT INTO preferences (client_id, data_json, updated_at) VALUES (?, ?, ?)"
                " ON CONFLICT(client_id) DO UPDATE SET data_json = excluded.data_json,"
                " updated_at = excluded.updated_at",
                (client_id, json.dumps(data), time.time()),
            )

    # ----------------------------------------------------------- corrections
    def add_correction(self, job_id: str, action: str, payload: Dict[str, Any]) -> None:
        with self._conn() as conn:
            conn.execute(
                "INSERT INTO corrections (created_at, job_id, action, payload_json) VALUES (?, ?, ?, ?)",
                (time.time(), job_id, action, json.dumps(payload)),
            )

    # -------------------------------------------------------- embedding cache
    # Values are pickled python dicts of numpy arrays. Pickle is acceptable
    # here because the cache is written and read only by this process.
    def cache_get(self, image_hash: str, kind: str = "features") -> Optional[Any]:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT data FROM embed_cache WHERE image_hash = ? AND kind = ?",
                (image_hash, kind),
            ).fetchone()
        if row is None:
            return None
        try:
            return pickle.loads(row["data"])
        except Exception:
            return None

    def cache_put(self, image_hash: str, value: Any, kind: str = "features") -> None:
        blob = pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL)
        with self._conn() as conn:
            conn.execute(
                "INSERT INTO embed_cache (image_hash, kind, created_at, data) VALUES (?, ?, ?, ?)"
                " ON CONFLICT(image_hash, kind) DO UPDATE SET data = excluded.data,"
                " created_at = excluded.created_at",
                (image_hash, kind, time.time(), blob),
            )

    def cache_stats(self) -> Dict[str, Any]:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM embed_cache"
            ).fetchone()
        return {"entries": int(row["n"]), "bytes": int(row["bytes"])}

    def cache_prune(self, max_entries: int = 5000) -> int:
        with self._conn() as conn:
            cur = conn.execute(
                "DELETE FROM embed_cache WHERE image_hash IN ("
                "  SELECT image_hash FROM embed_cache ORDER BY created_at DESC"
                f"  LIMIT -1 OFFSET {int(max_entries)}"
                ")"
            )
            return cur.rowcount
