"""Per-service job registry. Each map view keeps its own SQLite file."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import traceback
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

STATUS_PENDING = "pending"
STATUS_READY = "ready"
STATUS_ERROR = "error"

_TABLE = """
CREATE TABLE IF NOT EXISTS jobs (
    slug TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    step INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 1,
    message TEXT NOT NULL DEFAULT '',
    meta_json TEXT,
    updated_at TEXT NOT NULL
)
"""


def _max_workers() -> int:
    raw = os.environ.get("GENERATE_MAX_WORKERS", "1")
    try:
        return max(1, int(raw))
    except ValueError:
        return 1


class JobBook:
    def __init__(self, path_of: Callable[[], Path]) -> None:
        self._path_of = path_of
        self._lock = threading.Lock()
        self._ready = False
        self._db_path: Path | None = None
        self._futures: dict[str, Future] = {}
        self._pool = ThreadPoolExecutor(max_workers=_max_workers(), thread_name_prefix="viewgen")

    def _connect(self) -> sqlite3.Connection:
        path = self._path_of()
        path.parent.mkdir(parents=True, exist_ok=True)
        if self._db_path != path:
            self._ready = False
            self._db_path = path
            self._futures.clear()
        conn = sqlite3.connect(str(path), check_same_thread=False, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=30000")
        return conn

    def init(self) -> None:
        with self._lock:
            if self._ready and self._db_path == self._path_of():
                return
            conn = self._connect()
            try:
                conn.execute(_TABLE)
                conn.execute(
                    "UPDATE jobs SET status = ?, message = ? WHERE status = ?",
                    (STATUS_ERROR, "interrupted by restart", STATUS_PENDING),
                )
                conn.commit()
            finally:
                conn.close()
            self._ready = True

    def _write(
        self,
        slug: str,
        status: str,
        *,
        message: str = "",
        meta: dict[str, Any] | None = None,
    ) -> None:
        self.init()
        now = datetime.now(UTC).isoformat()
        meta_json = json.dumps(meta, ensure_ascii=False) if meta is not None else None
        conn = self._connect()
        try:
            conn.execute(
                """
                INSERT INTO jobs (slug, status, step, total, message, meta_json, updated_at)
                VALUES (?, ?, 0, 1, ?, ?, ?)
                ON CONFLICT(slug) DO UPDATE SET
                    status=excluded.status,
                    message=excluded.message,
                    meta_json=excluded.meta_json,
                    updated_at=excluded.updated_at
                """,
                (slug, status, message, meta_json, now),
            )
            conn.commit()
        finally:
            conn.close()

    def snapshot(self, slug: str) -> dict[str, Any] | None:
        self.init()
        conn = self._connect()
        try:
            row = conn.execute("SELECT * FROM jobs WHERE slug = ?", (slug,)).fetchone()
        except sqlite3.Error:
            return None
        finally:
            conn.close()
        if row is None:
            return None
        meta = None
        if row["meta_json"]:
            try:
                meta = json.loads(row["meta_json"])
            except json.JSONDecodeError:
                meta = None
        return {
            "status": row["status"],
            "step": row["step"],
            "total": row["total"],
            "message": row["message"],
            "meta": meta,
        }

    def is_running(self, slug: str) -> bool:
        fut = self._futures.get(slug)
        return fut is not None and not fut.done()

    def submit(self, slug: str, work: Callable[[], dict[str, Any] | None]) -> None:
        self._write(slug, STATUS_PENDING, message="queued")

        def run() -> None:
            try:
                meta = work()
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                self._write(slug, STATUS_ERROR, message=str(exc))
                return
            self._write(slug, STATUS_READY, message="ready", meta=meta)

        self._futures[slug] = self._pool.submit(run)
