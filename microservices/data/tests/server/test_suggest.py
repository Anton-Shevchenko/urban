"""Photon suggestions stay inside Germany and the four settlement types."""

from __future__ import annotations

from server.suggest import photon_suggestions


def test_short_query_returns_nothing():
    assert photon_suggestions("a") == []
    assert photon_suggestions("  ") == []


def test_photon_suggestions_germany_settlements_only(monkeypatch):
    payload = {
        "features": [
            {
                "properties": {
                    "name": "München",
                    "state": "Bayern",
                    "countrycode": "DE",
                    "osm_key": "place",
                    "osm_value": "city",
                    "type": "city",
                }
            },
            {
                "properties": {
                    "name": "Munich",
                    "state": "Kansas",
                    "countrycode": "US",
                    "osm_key": "place",
                    "osm_value": "city",
                }
            },
            {
                "properties": {
                    "name": "Schwabing",
                    "state": "Bayern",
                    "countrycode": "DE",
                    "osm_key": "place",
                    "osm_value": "suburb",
                }
            },
            {
                "properties": {
                    "name": "Freising",
                    "state": "Bayern",
                    "countrycode": "DE",
                    "osm_key": "place",
                    "osm_value": "town",
                }
            },
            {
                "properties": {
                    "name": "Grünwald",
                    "state": "Bayern",
                    "countrycode": "DE",
                    "osm_key": "place",
                    "osm_value": "municipality",
                }
            },
            {
                "properties": {
                    "name": "Dorf",
                    "state": "Bayern",
                    "countrycode": "DE",
                    "osm_key": "place",
                    "osm_value": "village",
                }
            },
            {
                "properties": {
                    "name": "Grenze",
                    "state": "Bayern",
                    "country": "Deutschland",
                    "osm_key": "boundary",
                    "osm_value": "administrative",
                }
            },
        ]
    }

    monkeypatch.setattr("server.suggest.PHOTON.get_json", lambda *_a, **_k: payload)
    rows = photon_suggestions("mun")
    assert [row["name"] for row in rows] == ["München", "Freising", "Grünwald", "Dorf"]
    assert rows[0]["label"] == "München, Bayern"
    assert rows[0]["state"] == "Bayern"
    assert rows[0]["type"] == "city"
    assert rows[2]["type"] == "municipality"
    assert rows[3]["type"] == "village"
