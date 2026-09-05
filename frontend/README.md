# Wohn-Index Frontend

React + Vite + MapLibre SPA for the Wohn-Index map.

```bash
npm install
npm run dev      # http://localhost:5173 (proxies /api → :8000, /v1 → :8081)
npm test
npm run build    # tsc -b (strict) + vite build
```

In Docker Compose this image is served by nginx on port 8080 with `/api` proxied
to the `api` service and `/v1` to the gateway.

## Configuration

Both variables are optional and default to the current origin, which is what the
dev proxy and the nginx container provide. Set them for deployments without a
reverse proxy (see `.env.example`):

| Variable | Purpose |
| --- | --- |
| `VITE_API_URL` | Base URL of the Python data API |
| `VITE_GATEWAY_URL` | Base URL of the Go gateway used by the hex chat |

## Structure

- `src/api/client.ts` — HTTP layer. Every request has a timeout and accepts an
  `AbortSignal`; `pollUntilReady` additionally has an overall deadline.
- `src/api/city.ts` — the single resolve → generate → poll → load flow used by
  both the landing page and the map.
- `src/scoring/` — the Living Score engine. Weights and the hex property type
  are generated from `contracts/` and must not be edited by hand.
- `src/map/` — MapLibre layer config and paint.
