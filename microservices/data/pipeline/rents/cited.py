"""Hand-copied prices. A row counts only when it cites a publication."""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from pipeline import config

_KINDS = frozenset({"kaltmiete", "asking_rent", "sale"})
_RESOLUTIONS = frozenset({"Bezirk", "Stadt"})


@dataclass(frozen=True)
class CitedPrice:
    kind: str
    slug: str
    geography: str
    eur_per_m2: float
    year: int
    as_of: str
    resolution: str
    source: str
    source_url: str


def load_cited(slug: str | None = None) -> list[CitedPrice]:
    """Rows for one city, or every city when ``slug`` is omitted.

    Rows without an http(s) URL, a known kind, or a known resolution are dropped.
    A Bezirk row also needs a geography name. Stadt rows ignore geography.
    """
    path = config.OBSERVED_PRICES_CSV
    if not path.exists():
        return []
    table = pd.read_csv(path, dtype=str).fillna("")
    rows: list[CitedPrice] = []
    for raw in table.to_dict(orient="records"):
        kind = str(raw.get("kind", "")).strip()
        city = str(raw.get("slug", "")).strip()
        resolution = str(raw.get("resolution", "")).strip()
        url = str(raw.get("source_url", "")).strip()
        source = str(raw.get("source", "")).strip()
        geography = str(raw.get("geography", "")).strip()
        if kind not in _KINDS or resolution not in _RESOLUTIONS or not source:
            continue
        if not (url.startswith("http://") or url.startswith("https://")):
            continue
        if slug is not None and city != slug:
            continue
        if resolution == "Bezirk" and not geography:
            continue
        if resolution == "Stadt":
            geography = ""
        try:
            euros = float(str(raw.get("eur_per_m2", "")).replace(",", "."))
            year = int(float(raw.get("year", "")))
        except ValueError:
            continue
        if euros <= 0 or year < 1990:
            continue
        rows.append(
            CitedPrice(
                kind=kind,
                slug=city,
                geography=geography,
                eur_per_m2=euros,
                year=year,
                as_of=str(raw.get("as_of", "")).strip() or str(year),
                resolution=resolution,
                source=source,
                source_url=url,
            )
        )
    return rows
