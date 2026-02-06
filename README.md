# IKEA Lookup (Docker)

This project serves a shiny web UI and a small proxy API that fetches IKEA AU data server-side (no browser CORS issues).

## What it shows
- Online (market) price via: `/range/v6/{market}/{lang}/browse/product-details/{article}`
- In-store price + department via: `/scan-shop/v6/{market}/{lang}/stores/{store}/product/{article}/1`
- In-store stock text (and qty) via: `/range/v6/{market}/{lang}/browse/availability/product/{article}?storeIds={store}`

## UI features
- **Australia store dropdown** (store name + ID) is sourced from `ikea-availability-checker`.
- **Store hours** are scraped from the selected store's IKEA page (e.g. `/au/en/stores/perth/`) and displayed in the UI.
- **ChangeDetection page** format is: `/<STOREID>/<ARTICLEID>` (server-rendered, large readable text).
- **Debug tab** contains the raw JSON plus a button to copy the `/api/lookup` URL.

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

## ChangeDetection
- `GET /556/40492331` (store 556, article 40492331)

### Preventing "store closed" alert spam
If IKEA closes the store early (end-of-day handling), the `scan-shop` endpoint can return `STORE_CLOSED` and in-store
price/qty may disappear. ChangeDetection's "Restock & Price" processor can misinterpret that as a price change.

This project now supports two behaviours for the `/<STOREID>/<ARTICLEID>` endpoint:
- **freeze** (default): serves the last-known-good in-store price/qty from disk so content stays stable.
- **503** or **404**: returns a non-2xx when the store is closed so ChangeDetection won't process the page.

Environment variables:
- `CD_STORE_CLOSED_BEHAVIOR=freeze|503|404` (default `freeze`)
- `DATA_DIR=/app/data` (default `/app/data`)
- `CD_STALE_MAX_AGE_MS=...` (default 7 days)

## Notes
- These IKEA endpoints are not an official public API contract and may change.
- The server includes a small in-memory TTL cache to reduce repeated calls.
- In-store data is often only available while the selected store is open.
