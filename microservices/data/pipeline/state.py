"""Step-level resume manifest for a city generation run.

A full run is 17 Overpass-bound steps and takes tens of minutes. Without a
manifest, a failure on step 15 meant redoing steps 1-14. The manifest records
which steps finished under which contract version, so a retry skips them.

The manifest lives next to the factor parquets in ``<city>/cache`` and is
invalidated whenever the pipeline schema or the scoring method changes, since
both can alter what a step is expected to write.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from . import config
from .common import log

STATE_FILE = ".pipeline_state.json"
STEP = "state"


def _fingerprint() -> dict[str, object]:
    return {
        "pipeline_version": int(config.PIPELINE_SCHEMA_VERSION),
        "score_method_version": str(config.SCORE_METHOD_VERSION),
    }


@dataclass
class PipelineState:
    """Completed steps of one city, persisted as JSON."""

    path: Path
    completed: set[str]

    @classmethod
    def load(cls, cache_dir: Path, *, force: bool = False) -> PipelineState:
        """Read the manifest, discarding it on ``force`` or contract drift."""
        path = cache_dir / STATE_FILE
        if force:
            return cls(path=path, completed=set())
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return cls(path=path, completed=set())
        if not isinstance(raw, dict):
            return cls(path=path, completed=set())
        expected = _fingerprint()
        for key, value in expected.items():
            if raw.get(key) != value:
                log(STEP, f"discarding resume manifest: {key} changed")
                return cls(path=path, completed=set())
        steps = raw.get("completed_steps")
        completed = {str(s) for s in steps} if isinstance(steps, list) else set()
        return cls(path=path, completed=completed)

    def is_done(self, step: str) -> bool:
        return step in self.completed

    def mark_done(self, step: str) -> None:
        self.completed.add(step)
        self.save()

    def clear(self) -> None:
        self.completed.clear()
        self.path.unlink(missing_ok=True)

    def save(self) -> None:
        payload = {
            **_fingerprint(),
            "updated_at": datetime.now(UTC).isoformat(),
            "completed_steps": sorted(self.completed),
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(self.path)
