# 15-Minuten-Living-Score (Deutschland)

Interaktive Karte: **Wie gut lässt es sich hier ohne Auto leben?**

Jedes Gebiet (H3-Hexagon, ~250 m) erhält einen erklärbaren Score **0–100**:

| Score | Bedeutung |
|-------|-----------|
| 0 | stark autoabhängig |
| 100 | hochgradig fußläufig / 15-Minuten-Stadt |

## Score-Formel (7 Säulen)

```
Living Score =
  20% Alltag (Daily Life)
+ 20% Gehqualität (Walk)
+ 15% Grün (Green)
+ 15% ÖPNV (Transit)
+ 10% Zentralität (Centrality)
+ 10% Ruhe (Quiet)
+ 10% Wohnwert (Housing Value)
```

`s_living = Σ (w_i × pillar_i) / Σ w_i` (Gewichte müssen 1 ergeben).  
Frontend-Gewichte/Formeln: `frontend/src/scoring/formulas.ts`. Pipeline: `pipeline/config.py` + `pipeline/score_scales.py`.

### Alltag (Daily Life)

Gehzeit-Zugänglichkeit mit piecewise Walk-Band (nicht exponentiell):

`0–5 min → 100 · 10 → 70 · 15 → 30 · ≥20 → 0`

Gruppen: Food 30% · Education 20% · Health 15% · Services 15% · Restaurants/Cafés 10% · Other 10%.  
Pro Gruppe zählt die **beste** nahe Amenity. Parks gehören zum Grün-Index.

### Gehqualität

Straßennetz, Sicherheit, Komfort, Barrierefreiheit → `s_walk`.

### Grün

40% Parkdistanz (+ Fläche) · 30% Grünanteil · 20% Baumkronen · 10% Wasser → `s_green`.

### ÖPNV

Distanz + Takt + Konnektivität (GTFS wenn verfügbar, sonst OSM) → `s_transit`.

### Zentralität

Nähe zu (polycentrischen) Zentren → `s_center`.

### Ruhe

Lärm → Quiet-Score (höher = ruhiger) → `s_quiet`.

### Wohnwert

`0.50×Affordability + 0.25×Alltag + 0.25×(0.5×ÖPNV + 0.5×Gehqualität)` → `s_housing_value`.

## Profile

Profile normalisieren die Säulen-Gewichte neu; optional `dl_*`-Gruppenmultiplikatoren und `affordability_focus` (blendet Wohnwert Richtung günstiger Miete).

| Profil | Fokus |
|--------|--------|
| Standard | feste Säulen 20/20/15/15/10/10/10 |
| Familie | Alltag, Grün, Wohnwert; Kita/Schule |
| Young Professional | ÖPNV + Zentralität |
| Senior | Wohnwert, Ruhe, Alltag; Preisfokus |
| Ohne Auto | Gehen + ÖPNV |
## Datenquellen

- OpenStreetMap (POI, Straßen, Grün, Landuse)
- GTFS / Mobilithek
- Zensus / Destatis (Dichte)
- Kommunale Open Data (Miete wo verfügbar)

## Pipeline (schema v11)

```bash
python3 -m venv .venv
./.venv/bin/pip install -r pipeline/requirements.txt

# München → frontend/public/data/hexes.geojson
./.venv/bin/python -m pipeline.run_all

# Beliebige deutsche Stadt
./.venv/bin/python -m pipeline.run_all "Hamburg"
```

Neue Schritte: `factor_walking_quality`, `factor_urban_form`; Export-Felder `s_living`, `s_daily_life`, `s_walking_quality`, `s_transit`, `s_urban_form`.

Ohne vollständigen OSM-Lauf kann das gebündelte München-GeoJSON angereichert werden:

```bash
./.venv/bin/python scripts/enrich_living_score_geojson.py
./.venv/bin/python scripts/living_score_validation.py
```

## Frontend

```bash
cd frontend && npm install && npm run dev
```

Oder Docker: `docker compose up --build` → UI `:8080`, API `:8000`.

## Phase 2 (geplant)

- Echtes OSM-Fußgängernetz (osmnx) statt Euclidean×Detour
- US Walk-Score-Kalibrierung (LR / RF / GBM)
- Adressgenaue Routing-API
- Stadtteil-Aggregation

## Struktur

```
pipeline/     # Python factors + export
server/       # FastAPI (city jobs)
frontend/     # React + MapLibre + living-score engine
scripts/      # validation / enrich
data/cities/  # per-city cache
```
