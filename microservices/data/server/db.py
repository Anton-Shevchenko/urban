"""SQLite index of city metadata, plus the generation-job registry.

The city product lives only on disk: ``hexes.geojson`` (what the map and
hex-svc read) and ``meta.json`` (the same meta object). This database stores
that meta for fast list/status checks and does not keep a second GeoJSON copy.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pipeline import config
from pipeline.common import log

_DB_PATH = config.DATA_DIR / "wohnindex.db"
_lock = threading.RLock()
_initialized = False

_CITIES_DDL = """
CREATE TABLE cities (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    meta_json TEXT NOT NULL,
    pipeline_version INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
)
"""


def connect() -> sqlite3.Connection:
    """Open a connection to the shared DB file.

    WAL plus a busy timeout lets the job registry write progress while a
    request reads city rows, instead of failing with "database is locked".
    """
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(_DB_PATH), check_same_thread=False, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def init_db() -> None:
    global _initialized
    with _lock:
        if _initialized:
            return
        conn = connect()
        try:
            _ensure_schema(conn)
        finally:
            conn.close()
        _initialized = True
    # Index disk after the schema exists. RLock lets upsert re-enter init_db.
    refresh_index()


def _ensure_schema(conn: sqlite3.Connection) -> None:
    """Create the metadata table, dropping a legacy GeoJSON blob column if present."""
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cities'"
    ).fetchone()
    if row is None:
        conn.execute(_CITIES_DDL)
    else:
        cols = {info["name"] for info in conn.execute("PRAGMA table_info(cities)")}
        if "geojson" in cols:
            conn.execute("ALTER TABLE cities RENAME TO cities_legacy")
            conn.execute(_CITIES_DDL)
            conn.execute(
                """
                INSERT INTO cities (slug, name, meta_json, pipeline_version, updated_at)
                SELECT slug, name, meta_json, pipeline_version, updated_at
                FROM cities_legacy
                """
            )
            conn.execute("DROP TABLE cities_legacy")
            log("db", "dropped legacy cities.geojson column")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cities_updated ON cities(updated_at DESC)")
    conn.commit()


def _hexes_path(slug: str) -> Path:
    return config.CITIES_DIR / slug / "hexes.geojson"


def _meta_path(city_dir: Path) -> Path:
    return city_dir / "meta.json"


def _meta_mtime(city_dir: Path) -> float | None:
    path = _meta_path(city_dir)
    if not path.is_file():
        return None
    return path.stat().st_mtime


def _stored_timestamp(updated_at: str | None) -> float | None:
    if not updated_at:
        return None
    try:
        return datetime.fromisoformat(updated_at).timestamp()
    except ValueError:
        return None


def _meta_is_newer(city_dir: Path, updated_at: str | None) -> bool:
    """True when meta.json is missing or newer than the indexed timestamp."""
    mtime = _meta_mtime(city_dir)
    if mtime is None:
        return True
    stored = _stored_timestamp(updated_at)
    if stored is None:
        return True
    return mtime > stored + 0.001


def _product_files_ready(slug: str) -> bool:
    """Both files exist and meta.json is not older than the GeoJSON export."""
    city_dir = config.CITIES_DIR / slug
    geo = city_dir / "hexes.geojson"
    meta = _meta_path(city_dir)
    if not geo.is_file() or not meta.is_file():
        return False
    # Export writes GeoJSON first, then meta.json. A newer GeoJSON is a partial write.
    return meta.stat().st_mtime + 0.001 >= geo.stat().st_mtime


def _row_updated_at(slug: str) -> str | None:
    with _lock:
        conn = connect()
        try:
            row = conn.execute("SELECT updated_at FROM cities WHERE slug = ?", (slug,)).fetchone()
        finally:
            conn.close()
    return row["updated_at"] if row else None


def _meta_from_geojson(geo: Path) -> dict[str, Any] | None:
    """One-time read of a legacy export that never wrote meta.json."""
    try:
        data = json.loads(geo.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        log("db", f"skip meta backfill {geo.parent.name}: {exc}")
        return None
    meta = data.get("meta") if isinstance(data, dict) else None
    if not isinstance(meta, dict):
        return None
    return meta


def load_city_meta(city_dir: Path) -> dict[str, Any] | None:
    """Read meta.json, backfilling it once from hexes.geojson when absent."""
    geo = city_dir / "hexes.geojson"
    if not geo.is_file():
        return None
    meta_path = _meta_path(city_dir)
    if not meta_path.exists():
        meta = _meta_from_geojson(geo)
        if meta is None:
            return None
        meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        log("db", f"skip index {city_dir.name}: {exc}")
        return None
    if not isinstance(meta, dict):
        return None
    # Directory name is the URL slug hex-svc scans. Keep the index on that key.
    meta["slug"] = city_dir.name
    if not meta.get("name"):
        meta["name"] = city_dir.name
    return meta


def upsert_city(
    slug: str,
    name: str,
    meta: dict[str, Any],
    *,
    updated_at: str | None = None,
) -> None:
    init_db()
    version = int(meta.get("pipeline_version") or 0)
    stamp = updated_at or datetime.now(UTC).isoformat()
    meta_json = json.dumps(meta, ensure_ascii=False)
    with _lock:
        conn = connect()
        try:
            conn.execute(
                """
                INSERT INTO cities (slug, name, meta_json, pipeline_version, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(slug) DO UPDATE SET
                    name=excluded.name,
                    meta_json=excluded.meta_json,
                    pipeline_version=excluded.pipeline_version,
                    updated_at=excluded.updated_at
                """,
                (slug, name, meta_json, version, stamp),
            )
            conn.commit()
        finally:
            conn.close()


def upsert_city_from_dir(city_dir: Path) -> dict[str, Any] | None:
    """Index meta.json for a city directory. Does not read the GeoJSON body when meta exists."""
    if not (city_dir / "hexes.geojson").is_file():
        return None
    meta = load_city_meta(city_dir)
    if meta is None:
        return None
    slug = str(meta.get("slug") or city_dir.name)
    name = str(meta.get("name") or slug)
    mtime = _meta_mtime(city_dir)
    stamp = datetime.fromtimestamp(mtime, tz=UTC).isoformat() if mtime is not None else None
    created = _row_updated_at(slug) is None
    upsert_city(slug, name, meta, updated_at=stamp)
    if created:
        log("db", f"indexed city {slug}")
    return meta


def _ensure_slug(slug: str) -> None:
    city_dir = config.CITIES_DIR / slug
    if not (city_dir / "hexes.geojson").is_file():
        return
    if not _meta_is_newer(city_dir, _row_updated_at(slug)):
        return
    upsert_city_from_dir(city_dir)


def _prune_absent(present: set[str]) -> None:
    with _lock:
        conn = connect()
        try:
            rows = conn.execute("SELECT slug FROM cities").fetchall()
            stale = [(row["slug"],) for row in rows if row["slug"] not in present]
            if not stale:
                return
            conn.executemany("DELETE FROM cities WHERE slug = ?", stale)
            conn.commit()
        finally:
            conn.close()


def refresh_index() -> None:
    """Reload meta.json when it is newer than the index, and drop cities with no file."""
    if not config.CITIES_DIR.is_dir():
        return
    present: set[str] = set()
    for city_dir in sorted(config.CITIES_DIR.iterdir()):
        if not city_dir.is_dir():
            continue
        if not (city_dir / "hexes.geojson").is_file():
            continue
        if not _meta_is_newer(city_dir, _row_updated_at(city_dir.name)):
            present.add(city_dir.name)
            continue
        try:
            indexed = upsert_city_from_dir(city_dir)
        except (OSError, json.JSONDecodeError) as exc:
            log("db", f"skip index {city_dir.name}: {exc}")
            continue
        if indexed is not None:
            present.add(city_dir.name)
    _prune_absent(present)


def list_cities() -> list[dict[str, Any]]:
    init_db()
    refresh_index()
    with _lock:
        conn = connect()
        try:
            rows = conn.execute(
                "SELECT meta_json FROM cities ORDER BY name COLLATE NOCASE"
            ).fetchall()
        finally:
            conn.close()
    out: list[dict[str, Any]] = []
    for row in rows:
        try:
            out.append(json.loads(row["meta_json"]))
        except json.JSONDecodeError:
            continue
    return out


def get_city_meta(slug: str) -> dict[str, Any] | None:
    init_db()
    _ensure_slug(slug)
    with _lock:
        conn = connect()
        try:
            row = conn.execute(
                "SELECT meta_json, pipeline_version FROM cities WHERE slug = ?",
                (slug,),
            ).fetchone()
        finally:
            conn.close()
    if row is None:
        return None
    try:
        meta = json.loads(row["meta_json"])
    except json.JSONDecodeError:
        return None
    meta.setdefault("pipeline_version", row["pipeline_version"])
    return meta


def is_db_city_current(slug: str) -> bool:
    # Index first so a legacy export missing meta.json is backfilled before the check.
    meta = get_city_meta(slug)
    if meta is None or not _product_files_ready(slug):
        return False
    version = int(meta.get("pipeline_version") or 0)
    if version < int(config.PIPELINE_SCHEMA_VERSION):
        return False
    product = meta.get("product")
    if product is not None and product != config.LIVING_SCORE_PRODUCT:
        return False
    # Flat noise usually means the OSM roads fetch was empty when the city was built.
    spread = meta.get("noise_db_spread")
    if spread is not None and float(spread) < 0.5:
        return False
    return True
