"""Zensus 2022 100 m grid: average net cold rent, 15 May 2022."""

from __future__ import annotations

import io
import zipfile

import geopandas as gpd
import pandas as pd
from shapely.geometry import Point

from pipeline import config
from pipeline.common import log
from pipeline.providers import DOWNLOAD

from .geometry import squares_from_centroids

STEP = "zensus_rent"
_KEEP_NOTES = frozenset({"", "KLAMMERN"})


def _parse_csv(raw: bytes | str) -> pd.DataFrame:
    source = io.BytesIO(raw) if isinstance(raw, bytes) else io.StringIO(raw)
    frame = pd.read_csv(source, sep=";", dtype=str)
    frame.columns = [str(column).strip().lstrip("\ufeff") for column in frame.columns]
    note = frame["werterlaeuternde_Zeichen"].fillna("").astype(str).str.strip().str.upper()
    rent = pd.to_numeric(frame["durchschnMieteQM"].astype(str).str.replace(",", ".", regex=False), errors="coerce")
    kept = frame.loc[note.isin(_KEEP_NOTES) & rent.notna() & (rent > 0)].copy()
    out = pd.DataFrame(
        {
            "x": pd.to_numeric(kept["x_mp_100m"].astype(str).str.replace(",", ".", regex=False), errors="coerce"),
            "y": pd.to_numeric(kept["y_mp_100m"].astype(str).str.replace(",", ".", regex=False), errors="coerce"),
            "rent": pd.to_numeric(
                kept["durchschnMieteQM"].astype(str).str.replace(",", ".", regex=False),
                errors="coerce",
            ),
            "flagged": kept["werterlaeuternde_Zeichen"].fillna("").astype(str).str.strip().str.upper().eq("KLAMMERN"),
        }
    )
    return out.dropna(subset=["x", "y", "rent"]).reset_index(drop=True)


def load_national_grid() -> pd.DataFrame | None:
    """Centroids in EPSG:3035. ``None`` when the zip cannot be read.

    Suppressed cells (GEHEIM and anything other than a plain or KLAMMERN value)
    are already dropped. KLAMMERN stays, marked ``flagged``.
    """
    cache = config.ZENSUS_CACHE_DIR / "nettokaltmiete_100m.parquet"
    if cache.exists():
        return pd.read_parquet(cache)
    try:
        resp = DOWNLOAD.get(config.ZENSUS_RENT_ZIP_URL)
        resp.raise_for_status()
        archive = zipfile.ZipFile(io.BytesIO(resp.content))
        member = next(
            name
            for name in archive.namelist()
            if name.endswith(config.ZENSUS_RENT_CSV_NAME) or name.endswith("100m-Gitter.csv")
        )
        frame = _parse_csv(archive.read(member))
    except Exception as exc:  # noqa: BLE001 - a missing census file is "no grid", not an estimate
        log(STEP, f"Zensus rent grid unavailable ({type(exc).__name__}: {exc})")
        return None
    frame.to_parquet(cache, index=False)
    log(STEP, f"cached {len(frame)} Zensus rent cells")
    return frame


def cells_for_bbox(grid: pd.DataFrame | None, bbox: tuple[float, float, float, float]) -> gpd.GeoDataFrame:
    """Published 100 m cells overlapping the city bbox, as WGS84 squares.

    An empty frame means the grid loaded and this city has no published cells.
    That is different from a failed download, which is ``load_national_grid`` → None.
    """
    empty = gpd.GeoDataFrame({"rent": [], "flagged": []}, geometry=[], crs=config.WGS84)
    if grid is None or grid.empty:
        return empty
    south, west, north, east = bbox
    corners = gpd.GeoSeries(
        [Point(west, south), Point(east, north), Point(west, north), Point(east, south)],
        crs=config.WGS84,
    ).to_crs("EPSG:3035")
    minx, miny, maxx, maxy = corners.total_bounds
    pad = 200.0
    part = grid[
        grid["x"].between(minx - pad, maxx + pad) & grid["y"].between(miny - pad, maxy + pad)
    ]
    if part.empty:
        return empty
    return gpd.GeoDataFrame(
        {"rent": part["rent"].to_numpy(), "flagged": part["flagged"].to_numpy()},
        geometry=list(squares_from_centroids(part["x"].to_numpy(), part["y"].to_numpy())),
        crs=config.WGS84,
    )
