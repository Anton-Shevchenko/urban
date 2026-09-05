---
name: check-scoring-formulas
description: >-
  Reads Living Score contracts before any scoring work. Use when changing or
  discussing living score, pillars, weights, PRESETS, daily-life groups,
  housing value, walk bands, map paint thresholds, metrics, or anything under
  frontend/src/scoring/ or contracts/.
---

# Check Scoring Formulas First

## Mandatory first step

Before any other file reads, searches, or edits related to scoring:

1. **Read** `contracts/scoring.json` (objective weights, daily-life groups, walk bands).
2. **Read** `contracts/metrics.json` (pipeline steps, metric ids, labels, hex fact sheet).
3. Treat those JSON files as the **source of truth**. Generated views live in:
   - `microservices/data/pipeline/generated/contract.py`
   - `frontend/src/scoring/generated/contract.ts`
   - `gen/contract/contract.go`
4. `frontend/src/scoring/formulas.ts` holds **PRESETS / personal match only**. Do not put objective weights there.
5. Only after that, inspect callers, UI, pipeline fields, or tests.

## What to verify when reading

- `objective_weights` in `scoring.json` sum to 1
- Pillar ids match `metrics.json` metrics with `kind: pillar`
- Walk-minute bands and daily-life group weights
- Housing-value composition and `affordability_focus` behavior (in `formulas.ts` PRESETS)
- After edits: `python contracts/codegen.py` and `make contract-check`

## After the read

- Prefer changing tunables in `contracts/scoring.json` / `contracts/metrics.json`
- If other code disagrees with the generated contract, update the other code
- Cite concrete keys from the JSON contracts when explaining scoring behavior
