"""Assemble observed Kaltmiete, Angebotsmiete, and Kaufpreis. Never mix them."""

from __future__ import annotations

import geopandas as gpd
import numpy as np
import pandas as pd

from pipeline import config
from pipeline.city import CityContext, slugify
from pipeline.common import log

from .admin import admin_polygons
from .cited import CitedPrice, load_cited
from .geometry import hexes_within, join_cell_rents
from .greix import asking_for_slug, load_asking
from .rent_index import load_index_factor
from .zensus_rent import cells_for_bbox, load_national_grid

STEP = "rents"

_NUMERIC = (
    "rent_eur_m2",
    "asking_rent_eur_m2",
    "sale_eur_m2",
)
_TEXT = (
    "rent_source",
    "rent_confidence",
    "rent_as_of",
    "rent_resolution",
    "asking_rent_source",
    "asking_rent_as_of",
    "sale_source",
    "sale_as_of",
)


def _housing_ids(frame: pd.DataFrame) -> set[str]:
    mask = pd.Series(False, index=frame.index)
    if "population" in frame.columns:
        mask = mask | (pd.to_numeric(frame["population"], errors="coerce").fillna(0) > 0)
    if "population_density" in frame.columns:
        mask = mask | (pd.to_numeric(frame["population_density"], errors="coerce").fillna(0) > 0)
    if "h3_index" not in frame.columns:
        return set()
    return set(frame.loc[mask, "h3_index"].astype(str))


def _write(frame: pd.DataFrame, h3: pd.Series, updates: dict[str, object]) -> None:
    """Overwrite ``h3`` rows. Later publications replace earlier ones."""
    keys = pd.Series(h3, copy=False).astype(str).reset_index(drop=True)
    if keys.empty:
        return
    targets = frame["h3_index"].astype(str)
    for column, value in updates.items():
        if isinstance(value, pd.Series):
            incoming = pd.Series(value.to_numpy(), index=keys)
        elif np.isscalar(value) or value is None or value is pd.NA:
            incoming = pd.Series(value, index=keys)
        else:
            incoming = pd.Series(np.asarray(value), index=keys)
        incoming = incoming[~incoming.index.duplicated(keep="first")]
        selected = targets.isin(set(incoming.index))
        if not selected.any():
            continue
        frame.loc[selected, column] = targets.map(incoming).loc[selected].to_numpy()


def _district_match(
    hexes: gpd.GeoDataFrame,
    polygons: gpd.GeoDataFrame | None,
    rows: list[CitedPrice],
) -> pd.DataFrame:
    empty = pd.DataFrame(columns=["h3_index", "eur_per_m2", "source", "as_of", "year", "resolution"])
    if polygons is None or polygons.empty or not rows:
        return empty
    by_name = {slugify(row.geography): row for row in rows if row.geography}
    areas = polygons.copy()
    areas["key"] = areas["name"].map(lambda name: slugify(str(name)))
    areas = areas[areas["key"].isin(by_name)]
    if areas.empty:
        return empty
    areas["eur_per_m2"] = areas["key"].map(lambda key: by_name[key].eur_per_m2)
    areas["source"] = areas["key"].map(lambda key: f"{by_name[key].source}, {by_name[key].resolution}")
    areas["as_of"] = areas["key"].map(lambda key: by_name[key].as_of)
    areas["year"] = areas["key"].map(lambda key: by_name[key].year)
    areas["resolution"] = areas["key"].map(lambda key: by_name[key].resolution)
    hit = hexes_within(hexes, areas)
    if hit.empty or "eur_per_m2" not in hit.columns:
        return empty
    return hit[["h3_index", "eur_per_m2", "source", "as_of", "year", "resolution"]].copy()


def _latest(rows: list[CitedPrice]) -> CitedPrice | None:
    if not rows:
        return None
    return max(rows, key=lambda row: (row.year, row.as_of))


def _blank_frame(hexes: gpd.GeoDataFrame) -> pd.DataFrame:
    frame = pd.DataFrame({"h3_index": hexes["h3_index"].astype(str).to_numpy()})
    for column in _NUMERIC:
        frame[column] = np.nan
    frame["rent_year"] = np.nan
    for column in _TEXT:
        frame[column] = pd.Series([None] * len(frame), dtype=object)
    return frame


def assemble_prices(
    hexes: gpd.GeoDataFrame,
    *,
    slug: str,
    cells: gpd.GeoDataFrame | None,
    grid_available: bool,
    index_factor: float | None,
    index_as_of: str | None,
    housing_h3: set[str],
    cited: list[CitedPrice],
    asking: tuple[float, str, str] | None,
    district_polygons: gpd.GeoDataFrame | None,
) -> pd.DataFrame:
    """One row per hex. Missing observations stay null. Series are never blended."""
    cited = [row for row in cited if row.slug == slug]
    frame = _blank_frame(hexes)
    if grid_available:
        joined = join_cell_rents(hexes, cells)
        if not joined.empty:
            if index_factor and index_as_of:
                rent = joined["rent_eur_m2"].astype(float) * float(index_factor)
                source = f"Zensus 2022, 100 m, fortgeschrieben bis {index_as_of}"
                as_of = index_as_of
            else:
                rent = joined["rent_eur_m2"].astype(float)
                source = "Zensus 2022, 100 m"
                as_of = "2022-05"
            confidence = np.where(joined["flagged"].astype(bool), "medium", "high")
            _write(
                frame,
                joined["h3_index"],
                {
                    "rent_eur_m2": rent,
                    "rent_source": source,
                    "rent_confidence": confidence,
                    "rent_year": config.ZENSUS_RENT_YEAR,
                    "rent_as_of": as_of,
                    "rent_resolution": "100 m",
                },
            )
    else:
        city = _latest([row for row in cited if row.kind == "kaltmiete" and row.resolution == "Stadt"])
        if city is not None and housing_h3:
            value = city.eur_per_m2
            source = f"{city.source}, Stadt"
            as_of = city.as_of
            if city.year == config.ZENSUS_RENT_YEAR and index_factor and index_as_of:
                value = value * float(index_factor)
                source = f"{city.source}, Stadt, fortgeschrieben bis {index_as_of}"
                as_of = index_as_of
            _write(
                frame,
                pd.Series(sorted(housing_h3)),
                {
                    "rent_eur_m2": value,
                    "rent_source": source,
                    "rent_confidence": "medium",
                    "rent_year": city.year,
                    "rent_as_of": as_of,
                    "rent_resolution": "Stadt",
                },
            )

    districts = _district_match(
        hexes,
        district_polygons,
        [row for row in cited if row.kind == "kaltmiete" and row.resolution == "Bezirk"],
    )
    if not districts.empty:
        _write(
            frame,
            districts["h3_index"],
            {
                "rent_eur_m2": districts["eur_per_m2"],
                "rent_source": districts["source"],
                "rent_confidence": "high",
                "rent_year": districts["year"],
                "rent_as_of": districts["as_of"],
                "rent_resolution": districts["resolution"],
            },
        )

    if asking is not None and housing_h3:
        euros, as_of, source = asking
        _write(
            frame,
            pd.Series(sorted(housing_h3)),
            {
                "asking_rent_eur_m2": euros,
                "asking_rent_source": source,
                "asking_rent_as_of": as_of,
            },
        )
    city_asking = _latest([row for row in cited if row.kind == "asking_rent" and row.resolution == "Stadt"])
    if city_asking is not None and housing_h3:
        _write(
            frame,
            pd.Series(sorted(housing_h3)),
            {
                "asking_rent_eur_m2": city_asking.eur_per_m2,
                "asking_rent_source": f"{city_asking.source}, Stadt",
                "asking_rent_as_of": city_asking.as_of,
            },
        )
    asking_districts = _district_match(
        hexes,
        district_polygons,
        [row for row in cited if row.kind == "asking_rent" and row.resolution == "Bezirk"],
    )
    if not asking_districts.empty:
        _write(
            frame,
            asking_districts["h3_index"],
            {
                "asking_rent_eur_m2": asking_districts["eur_per_m2"],
                "asking_rent_source": asking_districts["source"],
                "asking_rent_as_of": asking_districts["as_of"],
            },
        )

    city_sale = _latest([row for row in cited if row.kind == "sale" and row.resolution == "Stadt"])
    if city_sale is not None and housing_h3:
        _write(
            frame,
            pd.Series(sorted(housing_h3)),
            {
                "sale_eur_m2": city_sale.eur_per_m2,
                "sale_source": f"{city_sale.source}, Stadt",
                "sale_as_of": city_sale.as_of,
            },
        )
    sale_districts = _district_match(
        hexes,
        district_polygons,
        [row for row in cited if row.kind == "sale" and row.resolution == "Bezirk"],
    )
    if not sale_districts.empty:
        _write(
            frame,
            sale_districts["h3_index"],
            {
                "sale_eur_m2": sale_districts["eur_per_m2"],
                "sale_source": sale_districts["source"],
                "sale_as_of": sale_districts["as_of"],
            },
        )
    return frame


def _summarise(frame: pd.DataFrame) -> str:
    sources = frame["rent_source"].dropna().astype(str).unique()
    if len(sources) == 0:
        return "keine Beobachtung"
    if len(sources) == 1:
        return str(sources[0])
    return "beobachtete Kaltmiete"


def compute(ctx: CityContext) -> pd.DataFrame:
    """Observed prices for every hex in the city grid. Gaps stay empty."""
    grid = gpd.read_parquet(ctx.cache(config.GRID_FILE))
    if grid.crs is None:
        grid = grid.set_crs(config.WGS84)
    housing_path = ctx.cache(config.HOUSING_FILE)
    frame = grid
    if housing_path.exists():
        housing = pd.read_parquet(housing_path)
        columns = [name for name in ("h3_index", "population", "population_density") if name in housing.columns]
        if "h3_index" in columns and len(columns) > 1:
            frame = grid.merge(housing[columns], on="h3_index", how="left")
    housing_h3 = _housing_ids(frame)

    national = load_national_grid()
    grid_available = national is not None
    cells = cells_for_bbox(national, ctx.bbox) if grid_available else None
    factor = load_index_factor()
    index_factor, index_as_of = (None, None) if factor is None else factor
    cited = [row for row in load_cited(ctx.slug) if row.slug == slugify(ctx.slug) or row.slug == ctx.slug]
    asking = asking_for_slug(ctx.slug, load_asking())
    polygons = admin_polygons(ctx) if any(row.resolution == "Bezirk" for row in cited) else None

    out = assemble_prices(
        grid,
        slug=ctx.slug,
        cells=cells,
        grid_available=grid_available,
        index_factor=index_factor,
        index_as_of=index_as_of,
        housing_h3=housing_h3,
        cited=cited,
        asking=asking,
        district_polygons=polygons,
    )
    observed = pd.to_numeric(out["rent_eur_m2"], errors="coerce")
    ctx.has_rent = bool(observed.notna().any())
    ctx.rent_estimated = False
    ctx.rent_source = _summarise(out)
    if ctx.has_rent:
        log(STEP, f"{ctx.name}: Kaltmiete {observed.min():.1f}–{observed.max():.1f} €/m² ({ctx.rent_source})")
    else:
        log(STEP, f"{ctx.name}: keine beobachtete Kaltmiete")
    return out
