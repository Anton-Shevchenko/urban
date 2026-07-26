"""Germany-wide GTFS feed registry and lightweight headway parser.

Feeds are downloaded lazily per region and cached under ``data/gtfs/``.
When no feed is available the transit-service factor falls back to an
OSM station-class frequency estimate.
"""
from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pandas as pd
import requests

from . import config
from .city import CityContext
from .common import log

STEP = "gtfs"

# Regional GTFS sources (Mobilithek / GTFS.de style open data).
# ``bbox`` is (south, west, north, east) coverage hint for matching.
REGISTRY: list[dict] = [
    {
        "id": "mvv",
        "name": "MVV Gesamtnetz",
        "url": "https://download.mobilithek.info/browse/T_DOCID_8929678272034319377",
        "zip_url": None,  # resolved at runtime from Mobilithek landing page if needed
        "fallback_zip": "https://gtfs.mvv-muenchen.de/GTFS.zip",
        "bbox": (47.5, 10.5, 49.0, 12.5),
        "bundeslaender": {"BY"},
    },
    {
        "id": "vbb",
        "name": "VBB Berlin-Brandenburg",
        "fallback_zip": "https://gtfs.vbb.de/gtfs/vbb.zip",
        "bbox": (51.8, 12.0, 53.6, 14.8),
        "bundeslaender": {"BE", "BB"},
    },
    {
        "id": "vrs",
        "name": "VRS Rhein-Sieg",
        "fallback_zip": "https://download.vrs.de/gtfs/vrs.zip",
        "bbox": (50.5, 6.5, 51.2, 7.8),
        "bundeslaender": {"NW"},
    },
]

# Estimated departures/hour when GTFS is unavailable, by OSM station class.
OSM_CLASS_DEPARTURES = {
    "subway": 8.0,
    "station": 6.0,
    "light_rail": 5.0,
    "halt": 3.0,
    "tram": 10.0,
    "other": 4.0,
}


def _bbox_overlaps(city_bbox: tuple[float, float, float, float], feed_bbox: tuple) -> bool:
    cs, cw, cn, ce = city_bbox
    fs, fw, fn, fe = feed_bbox
    return not (cn < fs or cs > fn or ce < fw or cw > fe)


def feeds_for_city(ctx: CityContext) -> list[dict]:
    return [f for f in REGISTRY if _bbox_overlaps(ctx.bbox, f["bbox"])]


def _download_zip(url: str, dest: Path) -> bool:
    try:
        log(STEP, f"downloading GTFS {url}")
        resp = requests.get(url, timeout=120, headers={"User-Agent": config.USER_AGENT})
        if resp.status_code != 200:
            return False
        dest.write_bytes(resp.content)
        return True
    except requests.RequestException as exc:
        log(STEP, f"GTFS download failed: {exc}")
        return False


def ensure_feed(feed_id: str) -> Path | None:
    """Return path to cached GTFS zip, downloading if missing."""
    dest = config.GTFS_CACHE_DIR / f"{feed_id}.zip"
    if dest.exists() and dest.stat().st_size > 1000:
        return dest
    feed = next((f for f in REGISTRY if f["id"] == feed_id), None)
    if not feed:
        return None
    url = feed.get("fallback_zip") or feed.get("zip_url")
    if not url:
        return None
    if _download_zip(url, dest):
        return dest
    return None


def _read_csv(zf: zipfile.ZipFile, name: str) -> pd.DataFrame:
    for n in zf.namelist():
        if n.endswith(name) or n.lower().endswith(f"/{name}"):
            with zf.open(n) as fh:
                return pd.read_csv(fh, dtype=str, low_memory=False)
    return pd.DataFrame()


def stop_departures_per_hour(zip_path: Path, period: str = "weekday_morning") -> pd.DataFrame:
    """Parse GTFS zip and return stop_id -> departures/hour for a period."""
    try:
        with zipfile.ZipFile(zip_path) as zf:
            stops = _read_csv(zf, "stops.txt")
            stop_times = _read_csv(zf, "stop_times.txt")
            trips = _read_csv(zf, "trips.txt")
            calendar = _read_csv(zf, "calendar.txt")
    except (zipfile.BadZipFile, OSError) as exc:
        log(STEP, f"invalid GTFS zip {zip_path}: {exc}")
        return pd.DataFrame(columns=["stop_id", "departures_h"])

    if stop_times.empty or stops.empty:
        return pd.DataFrame(columns=["stop_id", "departures_h"])

    # Weekday morning: Mon-Fri 07:00-09:00
    if not calendar.empty:
        wd = calendar[calendar["monday"] == "1"]
        active_service = set(wd["service_id"].astype(str))
        if not trips.empty:
            trips = trips[trips["service_id"].astype(str).isin(active_service)]

    if trips.empty:
        return pd.DataFrame(columns=["stop_id", "departures_h"])

    st = stop_times.merge(trips[["trip_id", "route_id"]], on="trip_id", how="inner")
    st["dep_min"] = pd.to_numeric(
        st["departure_time"].astype(str).str.split(":").str[0], errors="coerce"
    ) * 60 + pd.to_numeric(
        st["departure_time"].astype(str).str.split(":").str[1], errors="coerce"
    )

    if period == "weekday_morning":
        st = st[(st["dep_min"] >= 7 * 60) & (st["dep_min"] < 9 * 60)]
    elif period == "evening":
        st = st[(st["dep_min"] >= 17 * 60) & (st["dep_min"] < 19 * 60)]
    elif period == "night":
        st = st[(st["dep_min"] >= 22 * 60) | (st["dep_min"] < 5 * 60)]
    else:
        st = st[(st["dep_min"] >= 10 * 60) & (st["dep_min"] < 18 * 60)]

    counts = st.groupby("stop_id").size().reset_index(name="departures_2h")
    counts["departures_h"] = counts["departures_2h"] / 2.0
    return counts[["stop_id", "departures_h"]]


def load_city_departures(ctx: CityContext) -> pd.DataFrame:
    """Best-effort departures/h per stop for the city's region."""
    frames = []
    for feed in feeds_for_city(ctx):
        path = ensure_feed(feed["id"])
        if path is None:
            continue
        dep = stop_departures_per_hour(path)
        if len(dep):
            dep["feed_id"] = feed["id"]
            frames.append(dep)
    if not frames:
        return pd.DataFrame(columns=["stop_id", "departures_h", "feed_id"])
    return pd.concat(frames, ignore_index=True)
