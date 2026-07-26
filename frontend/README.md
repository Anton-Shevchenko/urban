# Wohn-Index Frontend

React + Vite + MapLibre SPA for the Wohn-Index map.

```bash
npm install
npm run dev      # http://localhost:5173 (proxies /api → :8000)
npm test
npm run build
```

In Docker Compose this image is served by nginx on port 8080 with `/api` proxied to the `api` service.
