# Architecture backlog

Everything here is known, deliberate debt: real but less urgent than the
critical fixes already landed (data contract in `contracts/`, CI, shared
`urban/gen` + `urban/pkg`, gateway hardening, lazy per-city hex cache, pipeline
resume, frontend strict mode and request timeouts).

P1 and P2 from this list have landed: hex paint worker + MapView split,
`WohnIndexProvider` slice hooks, CSS tokens, pipeline factor waves, multi-stage
data image, Ollama split timeouts, versioned chat prompt.

Priorities describe *impact on the two stated goals* — number of cities, and
transparency of further development — not effort:

| Priority | Meaning |
| --- | --- |
| **P1** | Slows every future change or is user-visible today |
| **P2** | Noticeable friction, contained blast radius |
| **P3** | Needed only past roughly 20–50 cities |
| **P4** | Operational maturity, not required to ship |

## Done — P1 / P2 / registry

- Split `useWohnIndex` into `WohnIndexProvider` + slice hooks under `frontend/src/wohnindex/`
- Hex scoring in a Web Worker; `PAINT_DEBOUNCE_MS = 180`
- `MapView` split: `layerConfig`, `applyPaint`, `HexTooltip` (no `dangerouslySetInnerHTML`)
- Design tokens + `frontend/src/styles/{tokens,base,map,panels,home}.css`
- Pipeline factor waves in `pipeline/run.py` (thread pool; walking/urban-form after their parquet deps)
- Multi-stage `microservices/data/Dockerfile`
- Ollama connect / first-token / overall timeouts with connect-only retry
- Versioned prompt `hex_qa.v2.txt`; SSE `done` includes `prompt_version`
- `contracts/metrics.json` drives pipeline `STEPS`/`WAVES`, UI `SCORE_PROPS`, hex-svc fact-sheet keys
- Export writes `hexes.parquet` + `city-stats.json` beside GeoJSON; `s_match_*` no longer required
- City GeoJSON is only the on-disk `hexes.geojson` (hex-svc and the data API read that file). SQLite keeps city metadata and jobs, not a second GeoJSON copy

## P3 — needed as the city count grows

### Vector tiles instead of whole-city GeoJSON

A city is up to ~14 MB of GeoJSON, downloaded and parsed in full before the
first paint. Pre-generate `pmtiles` / MVT per city and let MapLibre fetch only
the visible tiles. This is the single biggest change for perceived speed and
for serving many cities from one host.

### DuckDB for cross-city analysis

The validation and reporting scripts under `microservices/data/scripts/` each
load parquet into pandas. DuckDB over the parquet files would let them query
across cities without a bespoke loader per script.

### PostGIS

Only if genuinely cross-city spatial queries appear (e.g. "compare all hexes
within 30 km of any Autobahn exit"). Until then H3 plus parquet is simpler and
faster.

## P4 — operational maturity

### Tracing and metrics

No OpenTelemetry spans and no Prometheus metrics anywhere. The gateway already
emits structured logs with a request ID that is propagated into gRPC metadata,
so the correlation key exists; exporters and instrumentation do not.

### mTLS for internal gRPC

`gateway/cmd/gateway/main.go` dials `hex-svc` and `llm-svc` with
`insecure.NewCredentials()`. Fine inside one Compose network, not fine once the
services span hosts.

### gRPC reflection

Enabling reflection on both services would make `grpcurl` debugging possible
without hand-written request files.

### Frontend developer ergonomics

TanStack Query would remove the hand-rolled caching and polling in
`src/api/`; component tests on jsdom would cover the panels (only the scoring
engine and the API layer are tested today); path aliases would replace
`../../` chains.
