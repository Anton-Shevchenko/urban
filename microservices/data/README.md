# urban-data

Living Score pipeline and FastAPI service. One installable Python project:
generate a city, serve the hex GeoJSON, refresh rents from cache.

```
microservices/data/
  pyproject.toml          # package metadata, deps, CLI, pytest, ruff
  pipeline/               # generation
    run.py                # orchestrator — steps/waves from contracts/metrics.json
    factors/              # one module per Living Score factor
    ingest/               # grid, OSM, centres, GTFS, Zensus
    rents/                # open-data + estimate
    export/               # merge, score, contract, GeoJSON + parquet/stats
    backfill/             # offline refresh of an existing city
    generated/            # contracts/codegen.py output — do not edit
  server/                 # FastAPI — python -m server
  tests/
  scripts/                # manual QA CLIs
  data/                   # runtime cache + reference CSVs
```

## Install

From the repository root:

```bash
python3 -m venv .venv
./.venv/bin/pip install -e "./microservices/data[dev]"
```

`DATA_DIR` defaults to `microservices/data/data`. Override with `URBAN_ROOT`
and `DATA_DIR` when the package is installed outside this tree (Docker sets
both).

## Generate a city

```bash
python -m pipeline                 # München
python -m pipeline Hamburg
python -m pipeline Hamburg --force
# or:  urban-generate Hamburg
```

Resume is automatic: finished steps in `<city>/cache/.pipeline_state.json`
are skipped until the contract version changes.

Offline refresh of an already-generated city:

```bash
python -m pipeline.backfill.rents rosenheim
python -m pipeline.backfill.foundation muenchen
```

## API

```bash
python -m server                   # :8000
# or:  urban-data-api
```

`GET /api/cities`, `POST /api/generate`, `GET /api/city/{slug}.geojson`.

## Tests and lint

```bash
make test-py
make lint
```
