"""Rent map view: Zensus, GREIX and cited prices, own cache, city-relative score."""

from __future__ import annotations

import json

import pandas as pd

from pipeline import config
from pipeline.city import CityContext
from pipeline.export.score_scales import rent_percentile_score
from pipeline.grid_store import bind_grid
from pipeline.rents import main as rents_main
from services.runtime import json_number

_FIELDS = (
    "rent_eur_m2",
    "rent_source",
    "rent_as_of",
    "asking_rent_eur_m2",
    "asking_rent_source",
    "sale_eur_m2",
    "sale_source",
)


def run(ctx: CityContext) -> None:
    bind_grid(ctx)
    rents_main(ctx)
    frame = pd.read_parquet(ctx.cache(config.RENTS_FILE))
    relative = rent_percentile_score(frame["rent_eur_m2"]) if "rent_eur_m2" in frame.columns else None
    scores: dict[str, dict] = {}
    for pos, (_, row) in enumerate(frame.iterrows()):
        h3 = str(row["h3_index"])
        entry: dict = {
            "s_rent_relative_city": json_number(relative.iloc[pos]) if relative is not None else None,
        }
        for field in _FIELDS:
            if field not in frame.columns:
                continue
            value = row[field]
            if field.endswith("_m2"):
                entry[field] = json_number(value)
            else:
                text = "" if value is None or (isinstance(value, float) and pd.isna(value)) else str(value)
                entry[field] = text or None
        scores[h3] = entry
    observed = sum(1 for row in scores.values() if row.get("rent_eur_m2") is not None)
    ctx.has_rent = observed > 0
    dest = ctx.base_dir / "scores.json"
    dest.write_text(
        json.dumps(
            {"slug": ctx.slug, "has_rent": ctx.has_rent, "scores": scores},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
