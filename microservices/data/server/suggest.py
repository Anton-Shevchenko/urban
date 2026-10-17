"""Photon place suggestions limited to German settlements."""

from __future__ import annotations

from pipeline.providers import PHOTON

_PHOTON_URL = "https://photon.komoot.io/api/"
# minLon,minLat,maxLon,maxLat — Germany, slightly padded.
_DE_BBOX = "5.5,47.1,15.5,55.2"
_PLACE_TYPES = frozenset({"city", "town", "municipality", "village"})
_DE_COUNTRIES = frozenset({"de", "deutschland", "germany"})


def _in_germany(props: dict) -> bool:
    code = str(props.get("countrycode") or "").strip().upper()
    if code:
        return code == "DE"
    country = str(props.get("country") or "").strip().casefold()
    return country in _DE_COUNTRIES


def _place_type(props: dict) -> str:
    osm_key = str(props.get("osm_key") or "").strip().lower()
    if osm_key and osm_key != "place":
        return ""
    return str(props.get("osm_value") or props.get("type") or "").strip().lower()


def photon_suggestions(query: str, *, limit: int = 8) -> list[dict]:
    """German city/town/municipality/village hits for a combobox.

    Photon is relevance-ranked. Results outside Germany or outside the four
    place types are dropped. The caller resolves the chosen name with Nominatim.
    """
    query = query.strip()
    try:
        limit_n = int(limit)
    except (TypeError, ValueError):
        limit_n = 8
    limit_n = max(1, min(limit_n, 10))
    if len(query) < 2:
        return []

    data = PHOTON.get_json(
        _PHOTON_URL,
        params={"q": query, "lang": "de", "limit": 20, "bbox": _DE_BBOX},
    )
    suggestions: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for feature in data.get("features") or []:
        props = feature.get("properties") or {}
        if not _in_germany(props):
            continue
        place = _place_type(props)
        if place not in _PLACE_TYPES:
            continue
        name = str(props.get("name") or "").strip()
        if not name:
            continue
        state = str(props.get("state") or "").strip()
        key = (name.casefold(), state.casefold())
        if key in seen:
            continue
        seen.add(key)
        suggestions.append(
            {
                "name": name,
                "state": state,
                "type": place,
                "label": f"{name}, {state}" if state else name,
            }
        )
        if len(suggestions) >= limit_n:
            break
    return suggestions
