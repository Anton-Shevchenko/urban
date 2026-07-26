---
name: check-scoring-formulas
description: >-
  Reads Living Score formulas and weights before any scoring work. Use when
  changing or discussing living score, pillars, weights, PRESETS, daily-life
  groups, housing value, walk bands, map paint thresholds, or anything under
  frontend/src/scoring/.
---

# Check Scoring Formulas First

## Mandatory first step

Before any other file reads, searches, or edits related to scoring:

1. **Read** `/Users/antonshevchenko/Projects/urban/frontend/src/scoring/formulas.ts` in full (or enough to cover the relevant exports).
2. Treat that file as the **source of truth** for weights, pillars, PRESETS, overlays, and short-circuit behavior.
3. Only after that, inspect callers, UI, pipeline fields, or tests.

## What to verify when reading

- `LIVING_WEIGHTS` / `PILLAR_KEYS` and that default weights sum to 1
- Pillar meanings and pipeline field names in the file header
- Walk-minute bands and daily-life group weights
- Housing-value composition and `affordability_focus` behavior
- `PRESETS` renormalisation and optional `dl_*` multipliers
- `ABSOLUTE_PAINT_PILLAR_THRESHOLD` and related paint rules
- When `livingScore` short-circuits to precomputed `s_living`

## After the read

- Prefer changing tunables in `formulas.ts` over duplicating weights elsewhere
- If other code disagrees with `formulas.ts`, update the other code (or ask before changing the formulas)
- Cite concrete exports/constants from `formulas.ts` when explaining scoring behavior
