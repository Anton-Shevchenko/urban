"""Durable job registry: status survives restarts, concurrency stays bounded."""

from __future__ import annotations

import importlib
import threading

import pytest


@pytest.fixture
def jobs(tmp_path, monkeypatch):
    """A jobs module bound to a throwaway DB file."""
    from pipeline import config

    monkeypatch.setattr(config, "DATA_DIR", tmp_path)

    from server import db as db_module

    db = importlib.reload(db_module)
    monkeypatch.setattr(db, "_DB_PATH", tmp_path / "test.db")

    from server import jobs as jobs_module

    module = importlib.reload(jobs_module)
    module.init()
    return module


def _wait(module, slug: str, timeout: float = 5.0) -> dict:
    future = module._futures.get(slug)
    assert future is not None
    future.result(timeout=timeout)
    snap = module.snapshot(slug)
    assert snap is not None
    return snap


def test_unknown_slug_has_no_snapshot(jobs):
    assert jobs.snapshot("nowhere") is None


def test_progress_is_persisted(jobs):
    jobs.mark_queued("koeln", 17)
    assert jobs.snapshot("koeln") == {
        "status": "pending",
        "step": 0,
        "total": 17,
        "message": "queued",
    }

    jobs.mark_progress("koeln", 5, 17, "factor: green")
    snap = jobs.snapshot("koeln")
    assert snap["step"] == 5
    assert snap["message"] == "factor: green"


def test_a_finished_job_carries_its_meta(jobs):
    jobs.submit("bonn", lambda: {"slug": "bonn", "name": "Bonn"}, 17)
    snap = _wait(jobs, "bonn")

    assert snap["status"] == "ready"
    assert snap["step"] == 17
    assert snap["meta"] == {"slug": "bonn", "name": "Bonn"}


def test_a_failing_job_reports_the_exception(jobs):
    def boom() -> dict:
        raise RuntimeError("overpass down")

    jobs.submit("essen", boom, 17)
    snap = _wait(jobs, "essen")

    assert snap["status"] == "error"
    assert "overpass down" in snap["message"]


def test_status_outlives_the_process(jobs, tmp_path, monkeypatch):
    jobs.submit("mainz", lambda: {"slug": "mainz"}, 17)
    _wait(jobs, "mainz")

    from server import jobs as jobs_module

    restarted = importlib.reload(jobs_module)
    restarted.init()

    assert restarted.snapshot("mainz")["status"] == "ready"


def test_a_job_interrupted_by_a_restart_is_reported_as_failed(jobs):
    jobs.mark_queued("trier", 17)

    from server import jobs as jobs_module

    restarted = importlib.reload(jobs_module)
    restarted.init()

    snap = restarted.snapshot("trier")
    assert snap["status"] == "error"
    assert "restart" in snap["message"]


def test_is_running_tracks_only_live_work(jobs):
    release = threading.Event()

    def slow() -> dict:
        release.wait(timeout=5)
        return {}

    jobs.submit("aachen", slow, 17)
    assert jobs.is_running("aachen")

    release.set()
    _wait(jobs, "aachen")
    assert not jobs.is_running("aachen")


def test_concurrency_is_capped(tmp_path, monkeypatch):
    """A burst of requests must not open one Overpass conversation each."""
    from pipeline import config

    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setenv("GENERATE_MAX_WORKERS", "2")

    from server import db as db_module

    db = importlib.reload(db_module)
    monkeypatch.setattr(db, "_DB_PATH", tmp_path / "test.db")

    from server import jobs as jobs_module

    module = importlib.reload(jobs_module)
    module.init()

    running = threading.Semaphore(0)
    release = threading.Event()
    peak = 0
    live = 0
    guard = threading.Lock()

    def work() -> dict:
        nonlocal peak, live
        with guard:
            live += 1
            peak = max(peak, live)
        running.release()
        release.wait(timeout=5)
        with guard:
            live -= 1
        return {}

    for i in range(6):
        module.submit(f"city{i}", work, 17)

    for _ in range(2):
        assert running.acquire(timeout=5)
    release.set()
    for i in range(6):
        module._futures[f"city{i}"].result(timeout=5)

    assert peak <= 2
