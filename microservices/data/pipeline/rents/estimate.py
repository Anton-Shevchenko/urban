"""Observed housing prices. A hex without a publication stays empty."""

from __future__ import annotations

from pipeline import config
from pipeline.city import CityContext, munich_context
from pipeline.common import log

from .observe import compute

STEP = "rents"


def main(ctx: CityContext | None = None) -> None:
    ctx = ctx or munich_context()
    out = compute(ctx)
    dest = ctx.cache(config.RENTS_FILE)
    out.to_parquet(dest)
    log(STEP, f"saved -> rents.parquet (source: {ctx.rent_source})")


if __name__ == "__main__":
    main()
