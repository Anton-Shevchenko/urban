# 15-Minuten-Living-Score (Deutschland)

Interaktive Karte: **Wie gut lässt es sich hier ohne Auto leben?**

Jedes Gebiet (H3-Hexagon, ~250 m) erhält einen erklärbaren Score **0–100**:

| Score | Bedeutung |
|-------|-----------|
| 0 | stark autoabhängig |
| 100 | hochgradig fußläufig / 15-Minuten-Stadt |

## Score-Formel (aktuell: infra-only)

Gewichte stehen **nur** in [`contracts/scoring.json`](contracts/scoring.json).
Auf diesem Branch ist der objektive Score **100 % Alltag** (`daily_life: 1.0`);
die übrigen Säulen werden weiter exportiert, gehen aber mit Gewicht 0 ein.

Die klassische 6-Säulen-Mischung (20/15/15/15/15/20) ist eine
Einzeilen-Änderung in `scoring.json` + `python contracts/codegen.py`.

### Eine Quelle der Wahrheit

Gewichte, Daily-Life-Gruppen und Walk-Bänder stehen **nur** in
[`contracts/scoring.json`](contracts/scoring.json). Der Property-Vertrag von
`hexes.geojson` steht in
[`contracts/hex-properties.schema.json`](contracts/hex-properties.schema.json).
Pipeline-Schritte, Metric-IDs und Hex-Fact-Sheet stehen in
[`contracts/metrics.json`](contracts/metrics.json).

```bash
# Nach jeder Änderung an contracts/*.json:
python contracts/codegen.py     # erzeugt Python-, TypeScript- und Go-Views
make contract-check             # CI-Gate: generierter Code ist aktuell
```

| Konsument | Generierte Datei |
|-----------|------------------|
| Pipeline (Python) | `microservices/data/pipeline/generated/contract.py` |
| Scoring-Engine (TS) | `frontend/src/scoring/generated/contract.ts` |
| Go-Services | `gen/contract/contract.go` |

Persönliche Profile (`PRESETS`) sind bewusst **nicht** Teil des Vertrags: sie
verändern nur `personalMatchScore` und leben in
`frontend/src/scoring/formulas.ts`.

### Alltag (Daily Life)

Gehzeit-Zugänglichkeit mit piecewise Walk-Band (nicht exponentiell):

`0–5 min → 100 · 10 → 70 · 15 → 30 · ≥20 → 0`

Gruppen: Food 30% · Education 20% · Health 15% · Services 15% · Restaurants/Cafés 10% · Leisure 10%.  
Innerhalb einer Gruppe sind die Kategorien gewichtet (nicht «beste zählt»),
siehe `daily_life.category_weights` im Vertrag. Parks gehören zum Grün-Index.

### Gehqualität

Straßennetz, Sicherheit, Komfort, Barrierefreiheit → `s_walk`.

### Grün

40% Parkdistanz (+ Fläche) · 30% Grünanteil · 20% Baumkronen · 10% Wasser → `s_green`.

### ÖPNV

Distanz + Takt + Konnektivität (GTFS wenn verfügbar, sonst OSM) → `s_transit`.

### Ruhe

Lärm → Quiet-Score (höher = ruhiger) → `s_quiet`.

### Bezahlbarkeit

Absolute Kaltmieten-Benchmark (nicht stadt-relativ) → `s_housing_affordability`.
Alltag/ÖPNV/Gehqualität werden hier **nicht** eingemischt, sonst würden sie
doppelt zählen.

### Zentralität (informativ, Gewicht 0)

Nähe zu (polyzentrischen) Zentren → `s_center`.

### Kartenansicht (Overlays)

Zusätzlich zum Infrastruktur-Score kann die Karte **Overlay-Metriken** einfärben.
Die erste (und vorerst einzige) Option: **Radwege** — nur baulich getrennte
Wege aus OSM (`highway=cycleway`, `cycleway=track`). Radfahrstreifen auf der
Fahrbahn zählen nicht. Overlay-Scores gehen **nicht** in den Living Score ein.

Registriert in [`contracts/metrics.json`](contracts/metrics.json) mit
`"map_view": true`.

## Profile

Auf diesem Branch sind alle Profile Kopien der objektiven Gewichte (100 % Alltag).
`PRESETS` in `frontend/src/scoring/formulas.ts` remixen nur `personalMatchScore`,
sobald die Säulen-Gewichte in `scoring.json` wieder ungleich null sind.

## Datenquellen

- OpenStreetMap (POI, Straßen, Grün, Landuse)
- GTFS / Mobilithek
- Zensus / Destatis (Dichte)
- Kommunale Open Data (Miete wo verfügbar)

## Pipeline

Schema-Version: `x-pipeline-version` in `contracts/hex-properties.schema.json`.
Ältere Caches werden von `pipeline.cache_status` erkannt und neu erzeugt.

```bash
python3 -m venv .venv
./.venv/bin/pip install -e "./microservices/data[dev]"

# München → frontend/public/data/hexes.geojson
./.venv/bin/python -m pipeline

# Beliebige deutsche Stadt
./.venv/bin/python -m pipeline "Hamburg"

# Nach einem Abbruch: abgeschlossene Schritte werden übersprungen
./.venv/bin/python -m pipeline "Hamburg"

# Alles neu rechnen
./.venv/bin/python -m pipeline "Hamburg" --force
```

Siehe [microservices/data/README.md](microservices/data/README.md) für die
Paketstruktur (`factors/`, `ingest/`, `export/`, …) und die HTTP-API.

Der Export wird vor dem Schreiben gegen
`contracts/hex-properties.schema.json` validiert — ein fehlendes oder falsch
typisiertes Property bricht die Generierung ab, statt erst im Browser aufzufallen.

Abgeschlossene Schritte stehen in `<stadt>/cache/.pipeline_state.json`. Das
Manifest wird verworfen, sobald `x-pipeline-version` oder
`score_method_version` sich ändern, damit ein Resume nie eine alte
Vertragsversion konserviert. Alle externen Provider (Nominatim, Overpass, WFS,
GTFS, Routing) laufen über `pipeline/providers.py` mit gemeinsamem
Retry/Backoff und Throttling — Nominatim mit den vorgeschriebenen 1 req/s.

Die API generiert auf einem `ThreadPoolExecutor` (`GENERATE_MAX_WORKERS`,
Default 2) und legt den Job-Status in SQLite ab, sodass Polling einen Restart
übersteht.

Verteilung und Plausibilität eines Exports prüfen:

```bash
./.venv/bin/python microservices/data/scripts/living_score_validation.py
```

## Frontend

```bash
cd frontend && npm install && npm run dev
```

Hex-Chat uses **native Ollama** on the host (Metal on macOS), not the CPU
container. Install [Ollama](https://ollama.com), then:

```bash
make ollama                 # ollama pull llama3.2:3b
make start                  # UI :8080, API :8000, Gateway :8081
```

If chat cannot reach the daemon, bind it on all interfaces:
`OLLAMA_HOST=0.0.0.0:11434 ollama serve`.

CPU-in-Docker fallback (slow on Mac):

```bash
OLLAMA_URL=http://ollama:11434 docker compose --profile bundled-ollama up --build
```

Answers are English, capped at 192 tokens, and the model stays loaded for 30 minutes.

## Tests

```bash
make test          # Go + Python + Frontend
make test-go       # go vet + go test
make test-py       # pytest (microservices/data)
make test-web      # tsc -b + vitest
make lint          # go vet + oxlint + ruff
make contract-check
make proto-check
```

## Phase 2 (geplant)

- Echtes OSM-Fußgängernetz (osmnx) statt Euclidean×Detour
- US Walk-Score-Kalibrierung (LR / RF / GBM)
- Adressgenaue Routing-API
- Stadtteil-Aggregation

## Struktur

```
contracts/                # scoring.json + metrics.json + hex schema + codegen
proto/                    # shared gRPC contracts
gen/                      # generated Go: gRPC stubs + scoring contract
pkg/                      # shared Go helpers (env, grpcserv)
frontend/                 # React + MapLibre + living-score engine
gateway/                  # HTTP/SSE BFF for hex chat
microservices/hex/        # gRPC hex lookup (lazy per-city LRU cache)
microservices/llm/        # gRPC Ollama adapter
microservices/data/       # Python project (urban-data): pipeline + FastAPI
docs/                     # architecture backlog
```

### Neue Metrik

1. Eintrag in [`contracts/metrics.json`](contracts/metrics.json) (id, `score_key`, factor-Modul, wave, labels).
2. Falls es eine Säule ist: Gewicht in [`contracts/scoring.json`](contracts/scoring.json).
3. Property-Typ in [`contracts/hex-properties.schema.json`](contracts/hex-properties.schema.json) (oder bump `x-pipeline-version`).
4. `python contracts/codegen.py` — erzeugt Python/TS/Go inkl. `STEPS`/`WAVES`.
5. `microservices/data/pipeline/factors/<id>.py` mit `main(ctx)`.
6. Tests + `make generate CITY=…`.

### Neuer gRPC-Service

1. `proto/<name>/v1/<name>.proto`
2. `make proto`
3. `microservices/<name>/cmd/<name>-svc/` + `Dockerfile` (build context = Repo-Root, wie hex/llm)
4. Modul in [`go.work`](go.work), Service in [`docker-compose.yml`](docker-compose.yml) mit `grpc_health_probe`
5. Dial + HTTP-Route in [`gateway/cmd/gateway/main.go`](gateway/cmd/gateway/main.go)
6. Öffentlich nur über Gateway `/v1/…` (nginx proxied das bereits)

Export schreibt neben `hexes.geojson` auch `hexes.parquet` und `city-stats.json`
(`GET /api/city/{slug}/hexes.parquet`, `GET /api/city/{slug}/stats`). Vector tiles
(PMTiles) sind der nächste Schritt, sobald tippecanoe im data-image liegt.

Weitere, nicht kritische Verbesserungen sind in
[docs/architecture-backlog.md](docs/architecture-backlog.md) nach Priorität
festgehalten.
