"""Step-level resume: manifest bookkeeping and generate_city skipping."""

from __future__ import annotations

import json
import threading

from pipeline import config
from pipeline import run as run_all
from pipeline.state import STATE_FILE, PipelineState


def test_manifest_round_trips_completed_steps(tmp_path):
    state = PipelineState.load(tmp_path)
    assert state.completed == set()

    state.mark_done("grid")
    state.mark_done("centers")

    reloaded = PipelineState.load(tmp_path)
    assert reloaded.is_done("grid")
    assert reloaded.is_done("centers")
    assert not reloaded.is_done("rents")


def test_manifest_records_the_contract_it_was_written_under(tmp_path):
    PipelineState.load(tmp_path).mark_done("grid")
    payload = json.loads((tmp_path / STATE_FILE).read_text(encoding="utf-8"))
    assert payload["pipeline_version"] == int(config.PIPELINE_SCHEMA_VERSION)
    assert payload["score_method_version"] == config.SCORE_METHOD_VERSION


def test_manifest_is_discarded_when_the_pipeline_version_moves(tmp_path):
    PipelineState.load(tmp_path).mark_done("grid")
    path = tmp_path / STATE_FILE
    payload = json.loads(path.read_text(encoding="utf-8"))
    payload["pipeline_version"] = int(config.PIPELINE_SCHEMA_VERSION) - 1
    path.write_text(json.dumps(payload), encoding="utf-8")

    assert PipelineState.load(tmp_path).completed == set()


def test_force_ignores_an_existing_manifest(tmp_path):
    PipelineState.load(tmp_path).mark_done("grid")
    assert PipelineState.load(tmp_path, force=True).completed == set()


def test_corrupt_manifest_is_treated_as_no_progress(tmp_path):
    (tmp_path / STATE_FILE).write_text("{not json", encoding="utf-8")
    assert PipelineState.load(tmp_path).completed == set()


class _FakeCtx:
    def __init__(self, cache_dir):
        self.cache_dir = cache_dir
        self.name = "Testkirchen"
        self.slug = "testkirchen"
        self.out_geojson = cache_dir / "hexes.geojson"


def _record_steps(monkeypatch) -> list[str]:
    """Replace every pipeline step with a recorder."""
    ran: list[str] = []
    lock = threading.Lock()

    def fake_steps():
        def make(name: str):
            def run(_ctx):
                with lock:
                    ran.append(name)

            return run

        return [(name, make(name)) for name, _ in run_all.STEPS]

    monkeypatch.setattr(run_all, "STEPS", fake_steps())
    monkeypatch.setattr(run_all, "_sync_munich_bundle", lambda ctx: None)
    return ran


def test_generate_city_runs_every_step_on_a_cold_cache(tmp_path, monkeypatch):
    ran = _record_steps(monkeypatch)
    run_all.generate_city(_FakeCtx(tmp_path))
    assert len(ran) == len(run_all.STEPS)


def test_generate_city_skips_steps_a_previous_run_finished(tmp_path, monkeypatch):
    ran = _record_steps(monkeypatch)
    ctx = _FakeCtx(tmp_path)

    run_all.generate_city(ctx)
    ran.clear()
    run_all.generate_city(ctx)

    # Only the export step reruns: it is cheap and it validates the contract.
    assert ran == [run_all.STEPS[-1][0]]


def test_force_reruns_everything(tmp_path, monkeypatch):
    ran = _record_steps(monkeypatch)
    ctx = _FakeCtx(tmp_path)

    run_all.generate_city(ctx)
    ran.clear()
    run_all.generate_city(ctx, force=True)

    assert len(ran) == len(run_all.STEPS)


def test_a_failed_step_does_not_get_marked_done(tmp_path, monkeypatch):
    ctx = _FakeCtx(tmp_path)
    boom_at = run_all.STEPS[2][0]

    def step(name):
        def run(_ctx):
            if name == boom_at:
                raise RuntimeError("overpass down")

        return run

    monkeypatch.setattr(run_all, "STEPS", [(name, step(name)) for name, _ in run_all.STEPS])
    monkeypatch.setattr(run_all, "_sync_munich_bundle", lambda ctx: None)

    try:
        run_all.generate_city(ctx)
    except RuntimeError:
        pass

    completed = PipelineState.load(tmp_path).completed
    assert boom_at not in completed
    assert run_all.STEPS[0][0] in completed


def test_waves_cover_every_step_exactly_once():
    names = [name for name, _ in run_all.STEPS]
    flat = [n for wave in run_all.WAVES for n in wave]
    assert sorted(flat) == sorted(names)
    assert len(flat) == len(set(flat))


def test_soft_dep_factors_are_not_in_the_first_parallel_wave():
    wave_d = run_all.WAVES[3]
    assert "factor: walking quality" not in wave_d
    assert "factor: urban form" not in wave_d
    assert "factor: center" not in wave_d
    later = [n for wave in run_all.WAVES[4:] for n in wave]
    assert "factor: walking quality" in later
    assert "factor: urban form" in later


def test_failed_step_in_a_parallel_wave_does_not_get_marked_done(tmp_path, monkeypatch):
    ctx = _FakeCtx(tmp_path)
    boom_at = "factor: green"
    ok_at = "factor: business"
    ran: list[str] = []
    lock = threading.Lock()

    def step(name):
        def run(_ctx):
            with lock:
                ran.append(name)
            if name == boom_at:
                raise RuntimeError("overpass down")

        return run

    monkeypatch.setattr(run_all, "STEPS", [(name, step(name)) for name, _ in run_all.STEPS])
    monkeypatch.setattr(run_all, "_sync_munich_bundle", lambda ctx: None)

    try:
        run_all.generate_city(ctx)
    except RuntimeError:
        pass

    completed = PipelineState.load(tmp_path).completed
    assert boom_at not in completed
    assert ok_at in completed
    assert "grid" in completed
