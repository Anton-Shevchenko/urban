"""Factor - housing quality and population density (Zensus or OSM proxy)."""
from __future__ import annotations

import pandas as pd

from . import config
from .city import CityContext, munich_context
from .common import log
from .zensus_loader import housing_metrics

STEP = "factor_housing"


def compute(ctx: CityContext) -> pd.DataFrame:
    out = housing_metrics(ctx)
    # Neutral housing quality index (sub-metrics exported separately).
    space = out["housing_space_m2_per_capita"].clip(20, 60)
    vacancy = (1 - out["vacancy_rate"].clip(0, 0.2) / 0.2) * 100
    out["housing_quality_score"] = ((space - 20) / 40 * 50 + vacancy * 0.5).clip(0, 100).round(1)
    log(
        STEP,
        f"housing computed (density mean={out['population_density'].mean():.0f}/km²)",
    )
    return out


def main(ctx: CityContext | None = None) -> None:
    ctx = ctx or munich_context()
    out = compute(ctx)
    dest = ctx.cache(config.HOUSING_FILE)
    out.to_parquet(dest)
    log(STEP, f"saved -> {dest}")


if __name__ == "__main__":
    main()
