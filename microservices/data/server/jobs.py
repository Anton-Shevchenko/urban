"""Durable generation-job registry backed by SQLite plus a bounded worker pool.

Replaces the previous in-memory ``_jobs`` dict and unbounded
``threading.Thread`` spawning. Two properties matter as the number of cities
grows:

* Status survives an API restart, so a client polling ``/api/status`` after a
  redeploy sees "interrupted" instead of a bare 404.
* Concurrency is capped, so ten simultaneous requests cannot open ten parallel
  Overpass conversations and get the whole deployment throttled.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import traceback
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import UTC, datetime
from typing import Any

from . import db

STATUS_PENDING = "pending"
STATUS_READY = "ready"
STATUS_ERROR = "error"

_TABLE = """
CREATE TABLE IF NOT EXISTS jobs (
    slug TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    step INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    meta_json TEXT,
    updated_at TEXT NOT NULL
)
"""

_lock = threading.Lock()
_initialized = False
_futures: dict[str, Future] = {}


def _max_workers() -> int:
    raw = os.environ.get("GENERATE_MAX_WORKERS", "2")
    try:
        return max(1, int(raw))
    except ValueError:
        return 2


_pool = ThreadPoolExecutor(max_workers=_max_workers(), thread_name_prefix="citygen")


def init() -> None:
    """Create the jobs table and fail over any job left running by a restart."""
    global _initialized
    with _lock:
        if _initialized:
            return
        conn = db.connect()
        try:
            conn.execute(_TABLE)
            # Nothing is executing right after startup, so a row still marked
            # pending belongs to a process that died mid-run.
            conn.execute(
                "UPDATE jobs SET status = ?, message = ? WHERE status = ?",
                (STATUS_ERROR, "interrupted by restart", STATUS_PENDING),
            )
            conn.commit()
        finally:
            conn.close()
        _initialized = True


def _write(
    slug: str,
    status: str,
    *,
    step: int = 0,
    total: int = 0,
    message: str = "",
    meta: dict[str, Any] | None = None,
) -> None:
    init()
    now = datetime.now(UTC).isoformat()
    meta_json = json.dumps(meta, ensure_ascii=False) if meta is not None else None
    conn = db.connect()
    try:
        conn.execute(
            """
            INSERT INTO jobs (slug, status, step, total, message, meta_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(slug) DO UPDATE SET
                status=excluded.status,
                step=excluded.step,
                total=excluded.total,
                message=excluded.message,
                meta_json=excluded.meta_json,
                updated_at=excluded.updated_at
            """,
            (slug, status, step, total, message, meta_json, now),
        )
        conn.commit()
    finally:
        conn.close()


def snapshot(slug: str) -> dict[str, Any] | None:
    """Return the stored job state for ``slug``, or None if never queued."""
    init()
    conn = db.connect()
    try:
        row = conn.execute("SELECT * FROM jobs WHERE slug = ?", (slug,)).fetchone()
    except sqlite3.Error:
        return None
    finally:
        conn.close()
    if row is None:
        return None
    out: dict[str, Any] = {
        "status": row["status"],
        "step": row["step"],
        "total": row["total"],
        "message": row["message"],
    }
    if row["meta_json"]:
        try:
            out["meta"] = json.loads(row["meta_json"])
        except json.JSONDecodeError:
            pass
    return out


def is_running(slug: str) -> bool:
    """True when a worker is currently generating this city in this process."""
    future = _futures.get(slug)
    if future is None:
        return False
    if future.done():
        _futures.pop(slug, None)
        return False
    return True


def mark_progress(slug: str, step: int, total: int, message: str) -> None:
    _write(slug, STATUS_PENDING, step=step, total=total, message=message)


def mark_queued(slug: str, total: int, message: str = "queued", step: int = 0) -> None:
    _write(slug, STATUS_PENDING, step=step, total=total, message=message)


def mark_ready(slug: str, total: int, meta: dict[str, Any] | None) -> None:
    _write(slug, STATUS_READY, step=total, total=total, message="done", meta=meta)


def mark_error(slug: str, exc: BaseException) -> None:
    _write(slug, STATUS_ERROR, message=f"{type(exc).__name__}: {exc}")


def submit(slug: str, work: Callable[[], dict[str, Any] | None], total: int) -> None:
    """Queue ``work`` for ``slug``; its return value becomes the ready meta."""

    def runner() -> None:
        try:
            meta = work()
            mark_ready(slug, total, meta)
        except Exception as exc:  # noqa: BLE001 - surfaced to the client via status
            traceback.print_exc()
            mark_error(slug, exc)

    _futures[slug] = _pool.submit(runner)


def queue_depth() -> int:
    """Jobs submitted in this process that have not finished yet."""
    return sum(1 for f in _futures.values() if not f.done())
