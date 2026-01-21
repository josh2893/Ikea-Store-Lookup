# IKEA Lookup (Docker)

This project serves a shiny web UI and a small proxy API that fetches IKEA AU data server-side (no browser CORS issues).

## What it shows
- Online (market) price via: `/range/v6/{market}/{lang}/browse/product-details/{article}`
- In-store price + department via: `/scan-shop/v6/{market}/{lang}/stores/{store}/product/{article}/1`
- In-store stock text (and qty) via: `/range/v6/{market}/{lang}/browse/availability/product/{article}?storeIds={store}`

## Quick start
1) Install Docker
2) In this folder run:

```bash
docker compose up -d --build
```

3) Open:
- http://localhost:8088

## API
- `GET /api/lookup?article=40492331&store=556&market=au&lang=en`

## Notes
- These IKEA endpoints are not an official public API contract and may change.
- The server includes a small in-memory TTL cache to reduce repeated calls.
