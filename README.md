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



## Changedetection.io (in-store only)
For a very simple, server-rendered page (no JS) that is easy for changedetection.io to scrape:

- `GET /{article}` (digits) e.g. `http://localhost:8088/10455151`

Optional query params:
- `store` (default `556`)
- `market` (default `au`)
- `lang` (default `en`)

This page shows **In Stock**, **Price**, and **Quantity**, and sets the HTML `<title>` to the IKEA item name (title + description).

## Notes
- These IKEA endpoints are not an official public API contract and may change.
- The server includes a small in-memory TTL cache to reduce repeated calls.
