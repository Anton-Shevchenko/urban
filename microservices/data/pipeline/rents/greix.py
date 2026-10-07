"""GREIX asking rents in €/m². Index-only rows are not turned into prices."""

from __future__ import annotations

import pandas as pd

from pipeline import config
from pipeline.city import slugify
from pipeline.common import log
from pipeline.providers import DOWNLOAD

from .sheet import read_xlsx_rows

STEP = "greix"
_SOURCE = "GREIX Angebotsmiete (Kiel Institut, VALUE Marktdatenbank), Stadt"


def latest_nominal_asking(rows: list[dict[str, object]]) -> pd.DataFrame:
    """Latest nominal ``AVG_PRICE_SQM`` per city (Inflation_adjusted == 0)."""
    best: dict[str, tuple[tuple[int, int], float, str]] = {}
    for row in rows:
        try:
            adjusted = float(row.get("Inflation_adjusted"))  # type: ignore[arg-type]
            price = float(row.get("AVG_PRICE_SQM"))  # type: ignore[arg-type]
            year = int(float(row["Year"]))  # type: ignore[arg-type]
            month = int(float(row["Month"]))  # type: ignore[arg-type]
        except (TypeError, ValueError, KeyError):
            continue
        if adjusted != 0 or price <= 0 or not 1 <= month <= 12:
            continue
        city = str(row.get("City") or "").strip()
        if not city:
            continue
        stamp = (year, month)
        slug = slugify(city)
        previous = best.get(slug)
        if previous is None or stamp >= previous[0]:
            best[slug] = (stamp, price, f"{year:04d}-{month:02d}")
    records = [
        {
            "slug": slug,
            "asking_rent_eur_m2": price,
            "asking_rent_as_of": as_of,
            "asking_rent_source": _SOURCE,
        }
        for slug, (_stamp, price, as_of) in best.items()
    ]
    return pd.DataFrame(records)


def load_asking() -> pd.DataFrame:
    """City-level asking rents. Empty when the workbook cannot be read."""
    cache = config.MARKET_CACHE_DIR / "greix_asking.parquet"
    workbook = config.MARKET_CACHE_DIR / "City_metrics_public.xlsx"
    if cache.exists():
        return pd.read_parquet(cache)
    try:
        if not workbook.exists():
            resp = DOWNLOAD.get(config.GREIX_ASKING_XLSX_URL)
            resp.raise_for_status()
            workbook.write_bytes(resp.content)
        frame = latest_nominal_asking(read_xlsx_rows(workbook, sheet="Tabelle1"))
    except Exception as exc:  # noqa: BLE001
        log(STEP, f"GREIX asking rents unavailable ({type(exc).__name__}: {exc})")
        return pd.DataFrame(columns=["slug", "asking_rent_eur_m2", "asking_rent_as_of", "asking_rent_source"])
    if frame.empty:
        return frame
    frame.to_parquet(cache, index=False)
    log(STEP, f"cached GREIX asking rents for {len(frame)} cities")
    return frame


def asking_for_slug(slug: str, frame: pd.DataFrame) -> tuple[float, str, str] | None:
    if frame.empty or "slug" not in frame.columns:
        return None
    hit = frame[frame["slug"] == slug]
    if hit.empty:
        return None
    row = hit.iloc[0]
    return float(row["asking_rent_eur_m2"]), str(row["asking_rent_as_of"]), str(row["asking_rent_source"])
