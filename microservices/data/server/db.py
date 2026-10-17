"""SQLite persistence for generated city GeoJSON + meta.

Pipeline factor caches (parquet) stay on disk under data/cities/<slug>/cache/.
Served city products (hexes.geojson + meta) are stored here for fast list/serve
and survive across API restarts when the DB file is on a mounted volume.
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
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS cities (
                    slug TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    meta_json TEXT NOT NULL,
                    geojson TEXT NOT NULL,
                    pipeline_version INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_cities_updated ON cities(updated_at DESC)")
            conn.commit()
        finally:
            conn.close()
        _initialized = True
    # Migrate outside the "first init" critical section; uses RLock safely.
    _migrate_filesystem_cities()


def _slug_exists(slug: str) -> bool:
    with _lock:
        conn = connect()
        try:
            row = conn.execute(
                "SELECT 1 FROM cities WHERE slug = ? LIMIT 1",
                (slug,),
            ).fetchone()
        finally:
            conn.close()
    return row is not None


def _migrate_filesystem_cities() -> None:
    """Import existing on-disk cities that are not yet in the DB."""
    if not config.CITIES_DIR.exists():
        return
    for d in sorted(config.CITIES_DIR.iterdir()):
        if not d.is_dir():
            continue
        geo = d / "hexes.geojson"
        if not geo.exists():
            continue
        slug = d.name
        if _slug_exists(slug):
            continue
        try:
            upsert_city_from_dir(d)
            log("db", f"migrated city {slug}")
        except (OSError, json.JSONDecodeError) as exc:
            log("db", f"skip migrate {slug}: {exc}")


def upsert_city(slug: str, name: str, meta: dict[str, Any], geojson_text: str) -> None:
    init_db()
    version = int(meta.get("pipeline_version") or config.PIPELINE_SCHEMA_VERSION)
    now = datetime.now(UTC).isoformat()
    meta_json = json.dumps(meta, ensure_ascii=False)
    with _lock:
        conn = connect()
        try:
            conn.execute(
                """
                INSERT INTO cities (slug, name, meta_json, geojson, pipeline_version, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(slug) DO UPDATE SET
                    name=excluded.name,
                    meta_json=excluded.meta_json,
                    geojson=excluded.geojson,
                    pipeline_version=excluded.pipeline_version,
                    updated_at=excluded.updated_at
                """,
                (slug, name, meta_json, geojson_text, version, now),
            )
            conn.commit()
        finally:
            conn.close()


def upsert_city_from_dir(city_dir: Path) -> dict[str, Any] | None:
    """Load hexes.geojson + meta from disk and persist to DB."""
    geo = city_dir / "hexes.geojson"
    if not geo.exists():
        return None
    raw = geo.read_text(encoding="utf-8")
    data = json.loads(raw)
    meta = data.get("meta") or {}
    meta_path = city_dir / "meta.json"
    if meta_path.exists():
        try:
            meta = {**meta, **json.loads(meta_path.read_text(encoding="utf-8"))}
        except (OSError, json.JSONDecodeError):
            pass
    slug = meta.get("slug") or city_dir.name
    name = meta.get("name") or slug
    upsert_city(slug, name, meta, raw)
    return meta


def list_cities() -> list[dict[str, Any]]:
    init_db()
    with _lock:
        conn = connect()
        try:
            rows = conn.execute("SELECT meta_json FROM cities ORDER BY name COLLATE NOCASE").fetchall()
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


def get_city_geojson_text(slug: str) -> str | None:
    init_db()
    with _lock:
        conn = connect()
        try:
            row = conn.execute(
                "SELECT geojson FROM cities WHERE slug = ?",
                (slug,),
            ).fetchone()
        finally:
            conn.close()
    return row["geojson"] if row else None


def disk_geojson_is_newer(slug: str, city_dir: Path) -> bool:
    """True when hexes.geojson on disk is newer than the SQLite row.

    A re-export can keep the same pipeline_version, so version checks alone
    would keep serving a stale blob from the DB.
    """
    path = city_dir / "hexes.geojson"
    if not path.exists():
        return False
    init_db()
    with _lock:
        conn = connect()
        try:
            row = conn.execute(
                "SELECT updated_at FROM cities WHERE slug = ?",
                (slug,),
            ).fetchone()
        finally:
            conn.close()
    if row is None:
        return True
    try:
        db_ts = datetime.fromisoformat(str(row["updated_at"]))
        if db_ts.tzinfo is None:
            db_ts = db_ts.replace(tzinfo=UTC)
    except ValueError:
        return True
    disk_ts = datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)
    return disk_ts > db_ts


def is_db_city_current(slug: str) -> bool:
    meta = get_city_meta(slug)
    if meta is None:
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
