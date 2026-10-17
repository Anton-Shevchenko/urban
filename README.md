# 15-minute living score (Germany)

Interactive map: **how well can you live here without a car?**

Each area (an H3 hexagon, ~250 m) gets an explainable score from **0–100**:

| Score | Meaning |
|-------|---------|
| 0 | strongly car-dependent |
| 100 | highly walkable / a 15-minute city |

## Score formula (current: infra-only)

Weights live **only** in [`contracts/scoring.json`](contracts/scoring.json).
On this branch the objective score is **100% daily life** (`daily_life: 1.0`);
the other pillars are still exported, but they enter with weight 0.

The classic 6-pillar mix (20/15/15/15/15/20) is a one-line change in
`scoring.json` plus `python contracts/codegen.py`.

### One source of truth

Weights, daily-life groups, and walk bands live **only** in
[`contracts/scoring.json`](contracts/scoring.json). The property contract for
`hexes.geojson` lives in
[`contracts/hex-properties.schema.json`](contracts/hex-properties.schema.json).
Pipeline steps, metric ids, and the hex fact sheet live in
[`contracts/metrics.json`](contracts/metrics.json).

```bash
# After every change to contracts/*.json:
python contracts/codegen.py     # writes the Python, TypeScript, and Go views
make contract-check             # CI gate: generated code is current
```

| Consumer | Generated file |
|----------|----------------|
| Pipeline (Python) | `microservices/data/pipeline/generated/contract.py` |
| Scoring engine (TS) | `frontend/src/scoring/generated/contract.ts` |
| Go services | `gen/contract/contract.go` |

Personal profiles (`PRESETS`) are deliberately **not** part of the contract:
they only change `personalMatchScore` and live in
`frontend/src/scoring/formulas.ts`.

### Daily life

Walk-time accessibility with a piecewise walk band (not exponential):

`0–5 min → 100 · 10 → 70 · 15 → 30 · ≥20 → 0`

Groups: Food 30% · Education 20% · Health 15% · Services 15% · Restaurants/Cafés 10% · Leisure 10%.
Inside a group, categories are weighted (not “best one wins”);
see `daily_life.category_weights` in the contract. Parks belong to the green index.

### Walking quality

Street network, safety, comfort, accessibility → `s_walk`.

### Green

40% park distance (+ area) · 30% green share · 20% tree canopy · 10% water → `s_green`.

### Transit

Distance + headway + connectivity (GTFS when available, otherwise OSM) → `s_transit`.

### Quiet

Noise → quiet score (higher = quieter) → `s_quiet`.

### Affordability

Absolute Kaltmiete benchmark (not city-relative) → `s_housing_affordability`.
`s_housing_value` is only an alias of that; daily life, transit, and walking
quality are **not** mixed in here, or they would be counted twice.

### Centrality (informative, weight 0)

Proximity to (polycentric) centres → `s_center`.

### Map view (overlays)

Besides the infrastructure score, the map can colour **overlay metrics**.
The first option is **cycleways** — only physically separated ways from OSM
(`highway=cycleway`, `cycleway=track`). Painted lanes on the carriageway do
not count. Overlay scores do **not** enter the living score.

Registered in [`contracts/metrics.json`](contracts/metrics.json) with
`"map_view": true`.

## Profiles

On this branch every profile is a copy of the objective weights (100% daily life).
`PRESETS` in `frontend/src/scoring/formulas.ts` remix only `personalMatchScore`,
once the pillar weights in `scoring.json` are non-zero again.

## Data sources

- OpenStreetMap (POIs, streets, green, land use)
- GTFS / Mobilithek
- Census / Destatis (density)
- Municipal open data (rent where available)

## Pipeline

Schema version: `x-pipeline-version` in `contracts/hex-properties.schema.json`.
Older caches are detected by `pipeline.cache_status` and rebuilt.

City GeoJSON is generated, not committed. `make generate` writes a city under
`microservices/data/data/cities/` (gitignored). For München it also copies
`hexes.geojson` and `cycleways.geojson` into `frontend/public/data/` so the
home map and the frontend image can serve them locally. Those copies are
gitignored too. Tests use the small sample in
`frontend/src/scoring/fixtures/hexes.sample.geojson`.

```bash
python3 -m venv .venv
./.venv/bin/pip install -e "./microservices/data[dev]"

# München → frontend/public/data/hexes.geojson (gitignored)
./.venv/bin/python -m pipeline

# Any German city
./.venv/bin/python -m pipeline "Hamburg"

# After an interrupt: finished steps are skipped
./.venv/bin/python -m pipeline "Hamburg"

# Recompute everything
./.venv/bin/python -m pipeline "Hamburg" --force
```

See [microservices/data/README.md](microservices/data/README.md) for the
package layout (`factors/`, `ingest/`, `export/`, …) and the HTTP API.

The export is validated against `contracts/hex-properties.schema.json` before
it is written. A missing or mistyped property fails generation instead of
showing up first in the browser.

Finished steps are recorded in `<city>/cache/.pipeline_state.json`. The
manifest is dropped as soon as `x-pipeline-version` or `score_method_version`
changes, so a resume never keeps an old contract version. All external
providers (Nominatim, Overpass, WFS, GTFS, routing) go through
`pipeline/providers.py` with shared retry/backoff and throttling — Nominatim
at the required 1 req/s.

The API generates on a `ThreadPoolExecutor` (`GENERATE_MAX_WORKERS`, default 2)
and stores job status in SQLite, so polling survives a restart.

Check the distribution and plausibility of an export (after `make generate`
has written the München bundle):

```bash
./.venv/bin/python microservices/data/scripts/living_score_validation.py
```

## Frontend

```bash
cd frontend && npm install && npm run dev
```

The home page lists cities from the data API. `/city/:slug` loads that city's
hexes from the API. For München, `make generate` also copies `hexes.geojson`
and `cycleways.geojson` into `frontend/public/data/` (gitignored) so nginx
can serve `/data/…`. `make start` builds the frontend image from that
directory: generate first if the image should contain the static bundle.

Hex chat uses **native Ollama** on the host (Metal on macOS), not the CPU
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

## Phase 2 (planned)

- A real OSM pedestrian network (osmnx) instead of Euclidean×detour
- US Walk Score calibration (LR / RF / GBM)
- Address-level routing API
- District aggregation

## Layout

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

### New metric

1. Entry in [`contracts/metrics.json`](contracts/metrics.json) (id, `score_key`, factor module, wave, labels).
2. If it is a pillar: weight in [`contracts/scoring.json`](contracts/scoring.json).
3. Property type in [`contracts/hex-properties.schema.json`](contracts/hex-properties.schema.json) (or bump `x-pipeline-version`).
4. `python contracts/codegen.py` — writes Python/TS/Go including `STEPS`/`WAVES`.
5. `microservices/data/pipeline/factors/<id>.py` with `main(ctx)`.
6. Tests + `make generate CITY=…`.

### New gRPC service

1. `proto/<name>/v1/<name>.proto`
2. `make proto`
3. `microservices/<name>/cmd/<name>-svc/` + `Dockerfile` (build context = repo root, as with hex/llm)
4. Module in [`go.work`](go.work), service in [`docker-compose.yml`](docker-compose.yml) with `grpc_health_probe`
5. Dial + HTTP route in [`gateway/cmd/gateway/main.go`](gateway/cmd/gateway/main.go)
6. Public only through the gateway `/v1/…` (nginx already proxies that)

The export writes `hexes.parquet` and `city-stats.json` next to `hexes.geojson`
(`GET /api/city/{slug}/hexes.parquet`, `GET /api/city/{slug}/stats`). Vector tiles
(PMTiles) are the next step, once tippecanoe is in the data image.

Further, non-critical improvements are listed by priority in
[docs/architecture-backlog.md](docs/architecture-backlog.md).

How to split a change is in [CONTRIBUTING.md](CONTRIBUTING.md).
