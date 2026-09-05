"""Run the full pipeline end to end for a given city."""

from __future__ import annotations

import importlib
import sys
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed

from pipeline.city import CityContext, munich_context, resolve_city, sync_munich_bundle
from pipeline.common import log
from pipeline.generated import contract as generated
from pipeline.state import PipelineState


def _bind_steps() -> tuple[list[tuple[str, Callable]], list[list[str]]]:
    """Resolve registry entries in contracts/metrics.json to callables."""
    steps: list[tuple[str, Callable]] = []
    waves: dict[int, list[str]] = {}
    for spec in generated.PIPELINE_STEPS:
        module = importlib.import_module(spec["module"])
        steps.append((spec["label"], getattr(module, spec["func"])))
        waves.setdefault(int(spec["wave"]), []).append(spec["label"])
    return steps, [waves[i] for i in sorted(waves)]


STEPS, WAVES = _bind_steps()

# Thread pool: Overpass is I/O-bound, and test doubles are nested functions
# that a process pool cannot pickle. GDAL/shapely still release the GIL.
MAX_WAVE_WORKERS = 4

StepCallback = Callable[[int, int, str], None]


def _sync_munich_bundle(ctx: CityContext) -> None:
    """Kept as a named hook so tests can stub the frontend copy."""
    sync_munich_bundle(ctx)


def _step_index() -> dict[str, int]:
    return {name: i for i, (name, _) in enumerate(STEPS, start=1)}


def generate_city(
    ctx: CityContext,
    on_step: StepCallback | None = None,
    *,
    force: bool = False,
    workers: int | None = None,
) -> CityContext:
    """Run every pipeline step, skipping those a previous run finished.

    Args:
        ctx: target city.
        on_step: progress callback ``(index, total, name)``.
        force: ignore and reset the resume manifest, rerunning every step.
        workers: max concurrent factor steps in a wave (default 4).
    """
    total = len(STEPS)
    state = PipelineState.load(ctx.cache_dir, force=force)
    by_name = dict(STEPS)
    index_of = _step_index()
    pool_size = MAX_WAVE_WORKERS if workers is None else max(1, workers)

    # The export step always reruns: it is cheap and it is what validates the
    # feature collection against the contract before anything is served.
    always_rerun = {
        spec["label"] for spec in generated.PIPELINE_STEPS if spec.get("always_rerun")
    }

    def run_named(name: str) -> str:
        log("run_all", f"===== {index_of[name]}/{total} {name} ({ctx.name}) =====")
        if on_step:
            on_step(index_of[name], total, name)
        by_name[name](ctx)
        return name

    with ThreadPoolExecutor(max_workers=pool_size) as pool:
        for wave in WAVES:
            pending: list[str] = []
            for name in wave:
                if name not in always_rerun and state.is_done(name):
                    log(
                        "run_all",
                        f"----- {index_of[name]}/{total} {name} ({ctx.name}) cached, skipping -----",
                    )
                    if on_step:
                        on_step(index_of[name], total, f"{name} (cached)")
                    continue
                pending.append(name)
            if not pending:
                continue
            if len(pending) == 1 or pool_size == 1:
                for name in pending:
                    run_named(name)
                    state.mark_done(name)
                continue
            futures = {pool.submit(run_named, name): name for name in pending}
            errors: list[tuple[str, BaseException]] = []
            for fut in as_completed(futures):
                name = futures[fut]
                try:
                    fut.result()
                except Exception as exc:
                    errors.append((name, exc))
                    continue
                state.mark_done(name)
            if errors:
                raise errors[0][1]

    _sync_munich_bundle(ctx)
    log("run_all", f"DONE -> {ctx.out_geojson}")
    return ctx


def main() -> None:
    args = [a for a in sys.argv[1:] if a != "--force"]
    force = "--force" in sys.argv[1:]
    query = args[0] if args else None
    ctx = resolve_city(query) if query else munich_context()
    generate_city(ctx, force=force)


if __name__ == "__main__":
    main()
