"""Default source / confidence metadata for exported metrics.

Values come from contracts/metrics.json via codegen. Edit the contract, not this file.
"""

from __future__ import annotations

from pipeline.generated.contract import METRIC_META, METRIC_TYPES

__all__ = ["METRIC_META", "METRIC_TYPES"]
