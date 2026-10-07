"""Observed rents stay empty wherever no publication covers the hex."""

from __future__ import annotations

import geopandas as gpd
import numpy as np
import pandas as pd
import pytest
from shapely.geometry import box

from pipeline import config
from pipeline.city import CityContext
from pipeline.export.score_scales import rent_percentile_score
from pipeline.rents.cited import load_cited
from pipeline.rents.greix import latest_nominal_asking
from pipeline.rents.observe import assemble_prices, compute
from pipeline.rents.rent_index import factor_from_series, parse_net_rent_index
from pipeline.rents.zensus_rent import _parse_csv


def _hexes() -> gpd.GeoDataFrame:
    return gpd.GeoDataFrame(
        {
            "h3_index": ["hex-a", "hex-b", "hex-park"],
            "population_density": [120.0, 40.0, 0.0],
        },
        geometry=[box(0, 0, 1, 1), box(2, 2, 3, 3), box(5, 5, 6, 6)],
        crs="EPSG:4326",
    )


def _cells() -> gpd.GeoDataFrame:
    return gpd.GeoDataFrame(
        {"rent": [10.0, 12.0], "flagged": [False, True]},
        geometry=[box(0.1, 0.1, 0.4, 0.4), box(0.5, 0.5, 0.8, 0.8)],
        crs="EPSG:4326",
    )


def _cited_city(year: int = 2024, kind: str = "kaltmiete", euros: float = 9.0):
    from pipeline.rents.cited import CitedPrice

    return CitedPrice(
        kind=kind,
        slug="muenchen",
        geography="",
        eur_per_m2=euros,
        year=year,
        as_of=str(year),
        resolution="Stadt",
        source="Amtliche Tabelle",
        source_url="https://example.test/rent",
    )


def test_cell_mean_leaves_hexes_without_a_published_cell_empty():
    out = assemble_prices(
        _hexes(),
        slug="muenchen",
        cells=_cells(),
        grid_available=True,
        index_factor=None,
        index_as_of=None,
        housing_h3={"hex-a", "hex-b"},
        cited=[],
        asking=None,
        district_polygons=None,
    ).set_index("h3_index")
    assert out.loc["hex-a", "rent_eur_m2"] == pytest.approx(11.0)
    assert out.loc["hex-a", "rent_confidence"] == "medium"
    assert out.loc["hex-a", "rent_resolution"] == "100 m"
    assert out.loc["hex-a", "rent_as_of"] == "2022-05"
    assert pd.isna(out.loc["hex-b", "rent_eur_m2"])
    assert pd.isna(out.loc["hex-park", "rent_eur_m2"])


def test_index_moves_only_the_may_2022_observation():
    out = assemble_prices(
        _hexes(),
        slug="muenchen",
        cells=_cells(),
        grid_available=True,
        index_factor=1.1,
        index_as_of="2026-08",
        housing_h3=set(),
        cited=[],
        asking=None,
        district_polygons=None,
    ).set_index("h3_index")
    assert out.loc["hex-a", "rent_eur_m2"] == pytest.approx(12.1)
    assert out.loc["hex-a", "rent_source"] == "Zensus 2022, 100 m, fortgeschrieben bis 2026-08"
    assert pd.isna(out.loc["hex-b", "rent_eur_m2"])


def test_city_average_does_not_fill_holes_in_a_loaded_grid():
    out = assemble_prices(
        _hexes(),
        slug="muenchen",
        cells=_cells(),
        grid_available=True,
        index_factor=1.5,
        index_as_of="2026-08",
        housing_h3={"hex-a", "hex-b"},
        cited=[_cited_city(2022, euros=8.0)],
        asking=None,
        district_polygons=None,
    ).set_index("h3_index")
    assert pd.isna(out.loc["hex-b", "rent_eur_m2"])
    assert out.loc["hex-a", "rent_resolution"] == "100 m"


def test_city_average_is_used_only_when_the_grid_is_missing_and_only_on_housing():
    out = assemble_prices(
        _hexes(),
        slug="muenchen",
        cells=None,
        grid_available=False,
        index_factor=1.5,
        index_as_of="2026-08",
        housing_h3={"hex-b"},
        cited=[_cited_city(2024, euros=9.0)],
        asking=None,
        district_polygons=None,
    ).set_index("h3_index")
    assert out.loc["hex-b", "rent_eur_m2"] == pytest.approx(9.0)
    assert "fortgeschrieben" not in str(out.loc["hex-b", "rent_source"])
    assert pd.isna(out.loc["hex-a", "rent_eur_m2"])
    assert pd.isna(out.loc["hex-park", "rent_eur_m2"])


def test_census_year_city_figure_is_indexed_when_the_grid_never_loaded():
    out = assemble_prices(
        _hexes(),
        slug="muenchen",
        cells=None,
        grid_available=False,
        index_factor=1.5,
        index_as_of="2026-08",
        housing_h3={"hex-b"},
        cited=[_cited_city(2022, euros=8.0)],
        asking=None,
        district_polygons=None,
    ).set_index("h3_index")
    assert out.loc["hex-b", "rent_eur_m2"] == pytest.approx(12.0)
    assert "fortgeschrieben bis 2026-08" in str(out.loc["hex-b", "rent_source"])


def test_cited_district_replaces_the_grid_inside_its_polygon():
    from pipeline.rents.cited import CitedPrice

    district = CitedPrice(
        kind="kaltmiete",
        slug="muenchen",
        geography="Schwabing",
        eur_per_m2=20.0,
        year=2024,
        as_of="2024",
        resolution="Bezirk",
        source="Mietspiegel",
        source_url="https://example.test/spiegel",
    )
    polygons = gpd.GeoDataFrame(
        {"name": ["Schwabing"]},
        geometry=[box(-0.5, -0.5, 1.5, 1.5)],
        crs="EPSG:4326",
    )
    out = assemble_prices(
        _hexes(),
        slug="muenchen",
        cells=_cells(),
        grid_available=True,
        index_factor=1.1,
        index_as_of="2026-08",
        housing_h3=set(),
        cited=[district],
        asking=(16.2, "2026-07", "GREIX Angebotsmiete, Stadt"),
        district_polygons=polygons,
    ).set_index("h3_index")
    assert out.loc["hex-a", "rent_eur_m2"] == pytest.approx(20.0)
    assert out.loc["hex-a", "rent_resolution"] == "Bezirk"
    assert "fortgeschrieben" not in str(out.loc["hex-a", "rent_source"])
    assert pd.isna(out.loc["hex-a", "asking_rent_eur_m2"])


def test_asking_rent_and_sale_stay_off_hexes_without_housing():
    from pipeline.rents.cited import CitedPrice

    sale = CitedPrice(
        kind="sale",
        slug="muenchen",
        geography="",
        eur_per_m2=8400,
        year=2024,
        as_of="2024",
        resolution="Stadt",
        source="Gutachterausschuss München",
        source_url="https://www.muenchen.de/gutachterausschuss",
    )
    out = assemble_prices(
        _hexes(),
        slug="muenchen",
        cells=None,
        grid_available=True,
        index_factor=None,
        index_as_of=None,
        housing_h3={"hex-b"},
        cited=[sale],
        asking=(16.2, "2026-07", "GREIX Angebotsmiete, Stadt"),
        district_polygons=None,
    ).set_index("h3_index")
    assert out.loc["hex-b", "asking_rent_eur_m2"] == pytest.approx(16.2)
    assert out.loc["hex-b", "sale_eur_m2"] == pytest.approx(8400)
    assert pd.isna(out.loc["hex-a", "asking_rent_eur_m2"])
    assert pd.isna(out.loc["hex-a", "sale_eur_m2"])
    assert pd.isna(out.loc["hex-park", "asking_rent_eur_m2"])
    assert pd.isna(out.loc["hex-b", "rent_eur_m2"])


def test_cited_table_drops_rows_without_a_url(tmp_path, monkeypatch):
    path = tmp_path / "observed_prices.csv"
    path.write_text(
        "kind,slug,geography,eur_per_m2,year,as_of,resolution,source,source_url\n"
        "kaltmiete,muenchen,,11,2024,2024,Stadt,Amt,https://example.test/a\n"
        "kaltmiete,muenchen,,12,2024,2024,Stadt,Amt,\n"
        "sale,muenchen,Maxvorstadt,5000,2024,2024,Bezirk,GAA,https://example.test/b\n"
        "sale,berlin,,1,2024,2024,Stadt,Nope,notaurl\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(config, "OBSERVED_PRICES_CSV", path)
    rows = load_cited("muenchen")
    assert [row.eur_per_m2 for row in rows] == [11.0, 5000.0]


def test_greix_keeps_nominal_euro_levels_and_skips_index_only_rows():
    frame = latest_nominal_asking(
        [
            {"Year": 2026, "Month": 6, "City": "München", "AVG_PRICE_SQM": 22.0, "Inflation_adjusted": 0},
            {"Year": 2026, "Month": 7, "City": "München", "AVG_PRICE_SQM": 21.0, "Inflation_adjusted": 1},
            {"Year": 2026, "Month": 7, "City": "München", "AVG_PRICE_SQM": 20.8, "Inflation_adjusted": 0},
            {"Year": 2026, "Month": 6, "City": "Berlin", "Index": 140, "Inflation_adjusted": 0},
        ]
    )
    assert frame["slug"].tolist() == ["muenchen"]
    assert frame.iloc[0]["asking_rent_eur_m2"] == pytest.approx(20.8)
    assert frame.iloc[0]["asking_rent_as_of"] == "2026-07"


def test_net_rent_index_uses_may_2022_as_the_base():
    html = """
    <table>
      <tr>
        <th colspan="2">Jahr, Monat</th>
        <th>Dienstleistungen</th>
        <th>Dienstleistungen ohne Nettokaltmiete</th>
        <th>Nettokaltmiete<br/>172,43 ‰</th>
      </tr>
      <tr>
        <th rowspan="2">2026</th>
        <th><abbr title="August">Aug</abbr></th>
        <td>122,1</td><td>127,5</td><td>111,8</td>
      </tr>
      <tr>
        <th><abbr title="Juli">Jul</abbr></th>
        <td>122,2</td><td>127,7</td><td>111,6</td>
      </tr>
      <tr>
        <th>2022</th>
        <th><abbr title="Mai">Mai</abbr></th>
        <td>110,0</td><td>114,0</td><td>102,7</td>
      </tr>
    </table>
    """
    series = parse_net_rent_index(html)
    assert (2022, 5, 102.7) in series
    assert (2026, 8, 111.8) in series
    factor, as_of = factor_from_series(series)
    assert as_of == "2026-08"
    assert factor == pytest.approx(111.8 / 102.7)


def test_suppressed_and_zero_cells_are_dropped_and_uncertain_cells_kept():
    raw = (
        "GITTER_ID_100m;x_mp_100m;y_mp_100m;durchschnMieteQM;werterlaeuternde_Zeichen\n"
        "CRS3035RES100mN1E1;1000;2000;6,26;\n"
        "CRS3035RES100mN1E2;1100;2000;4,45;KLAMMERN\n"
        "CRS3035RES100mN1E3;1200;2000;;GEHEIM\n"
        "CRS3035RES100mN1E4;1300;2000;0;\n"
    )
    frame = _parse_csv(raw)
    assert frame["rent"].tolist() == pytest.approx([6.26, 4.45])
    assert frame["flagged"].tolist() == [False, True]


def test_percentile_ignores_hexes_without_rent():
    scored = rent_percentile_score(pd.Series([10.0, np.nan, 30.0]))
    assert scored.iloc[0] == pytest.approx(100.0)
    assert pd.isna(scored.iloc[1])
    assert scored.iloc[2] == pytest.approx(0.0)


def test_compute_leaves_prices_null_without_observations(tmp_path, monkeypatch):
    ctx = CityContext(
        slug="muenchen",
        name="München",
        center=(48.1, 11.5),
        bbox=(48.0, 11.4, 48.2, 11.6),
        base_dir=tmp_path,
    )
    _hexes().to_parquet(ctx.cache(config.GRID_FILE))
    monkeypatch.setattr("pipeline.rents.observe.load_national_grid", lambda: None)
    monkeypatch.setattr("pipeline.rents.observe.load_cited", lambda slug=None: [])
    monkeypatch.setattr(
        "pipeline.rents.observe.load_asking",
        lambda: pd.DataFrame(columns=["slug", "asking_rent_eur_m2", "asking_rent_as_of", "asking_rent_source"]),
    )
    monkeypatch.setattr("pipeline.rents.observe.load_index_factor", lambda: None)

    def boom(*_args, **_kwargs):
        raise AssertionError("district geography must not be fetched without a cited row")

    monkeypatch.setattr("pipeline.rents.observe.admin_polygons", boom)
    out = compute(ctx)
    assert out["rent_eur_m2"].isna().all()
    assert out["asking_rent_eur_m2"].isna().all()
    assert out["sale_eur_m2"].isna().all()
    assert ctx.has_rent is False
    assert ctx.rent_estimated is False
    assert ctx.rent_source == "keine Beobachtung"
