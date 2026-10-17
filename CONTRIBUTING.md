# Contributing

Developer docs, code comments, and this file are English. The map UI stays German.

## One concern per pull request

Keep a change reviewable and revertible on its own. Do not mix these in one PR:

- **Contract** — `contracts/*.json` and the generated views (`python contracts/codegen.py` in the same PR). `make contract-check` must pass.
- **Pipeline** — factors, ingest, export, and their pytest files.
- **Frontend** — map, scoring engine, panels.
- **Prompt** — `prompts/` and the gateway chat prompt.

A metric that needs all four still lands as separate PRs, contract first.

## Generated city data

Do not commit city GeoJSON, parquet, or pipeline caches. `make generate` writes them under `microservices/data/data/cities/` and, for München, copies `hexes.geojson` and `cycleways.geojson` into `frontend/public/data/`. Both places are gitignored.

Frontend tests read `frontend/src/scoring/fixtures/hexes.sample.geojson`, a small sample of real hexes. Refresh that fixture by hand when the property contract changes; do not replace it with a full city export.
