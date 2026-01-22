import express from "express";

const app = express();
const PORT = Number(process.env.PORT || 8080);

// Defaults (can be overridden per-request by query params)
const DEFAULT_MARKET = String(process.env.DEFAULT_MARKET || "au").toLowerCase();
const DEFAULT_LANG = String(process.env.DEFAULT_LANG || "en").toLowerCase();
const DEFAULT_STORE = String(process.env.DEFAULT_STORE || "556");

// ---- Simple in-memory TTL cache (reduces hammering IKEA endpoints) ----
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 60_000); // 60s default
const cache = new Map(); // key -> { expires, value }

function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() > v.expires) {
    cache.delete(key);
    return null;
  }
  return v.value;
}

function cacheSet(key, value) {
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
  // basic bound to prevent unbounded growth
  if (cache.size > 500) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
}

function normArticle(article) {
  return String(article || "").replace(/\D/g, "");
}

async function fetchJson(url) {
  const cached = cacheGet(url);
  if (cached) return cached;

  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "ikea-lookup/1.0 (+https://localhost)"
    }
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${url}: ${txt.slice(0, 400)}`);
  }

  const data = await res.json();
  cacheSet(url, data);
  return data;
}

function stripHtml(input) {
  return (input ?? "").toString().replace(/<[^>]*>/g, "");
}

function formatCurrencyAud(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  // Keep it deterministic/stable for ChangeDetection
  return `$${n.toFixed(2)}`.replace(/\.00$/, ".00");
}

async function lookupArticle({ article, store, market, lang }) {
  const urls = {
    productDetails: `https://shop.api.ingka.ikea.com/range/v6/${market}/${lang}/browse/product-details/${article}`,
    scanShop: `https://shop.api.ingka.ikea.com/scan-shop/v6/${market}/${lang}/stores/${store}/product/${article}/1`,
    availability: `https://shop.api.ingka.ikea.com/range/v6/${market}/${lang}/browse/availability/product/${article}?storeIds=${store}`
  };

  const [details, scan, avail] = await Promise.all([
    fetchJson(urls.productDetails),
    fetchJson(urls.scanShop),
    fetchJson(urls.availability)
  ]);

  // Online (market) price + canonical product info
  const onlineTitle = details?.product?.title ?? null;
  const onlineDesc = details?.product?.description ?? details?.product?.typeName ?? null;
  const onlineUrl = details?.product?.productUrl ?? null;
  const onlineImg = details?.product?.images?.[0]?.imageUrl ?? null;

  const onlineRaw = details?.product?.pricePackage?.includingVat?.rawPrice ?? null;
  const onlinePretty = details?.product?.pricePackage?.includingVat?.sellingPrice ?? null;

  // In-store (store-specific)
  const storeRaw = scan?.presentationSection?.productCard?.product?.pricePackage?.includingVat?.rawPrice ?? null;
  const storePretty = scan?.presentationSection?.productCard?.product?.pricePackage?.includingVat?.sellingPrice ?? null;

  const scanTitle = scan?.presentationSection?.productCard?.product?.title ?? null;
  const scanDesc =
    scan?.presentationSection?.productCard?.product?.description ??
    scan?.presentationSection?.productCard?.product?.typeName ??
    null;

  const scanImg = scan?.presentationSection?.productCard?.product?.imageUrl ?? null;

  // IMPORTANT: division lives at location.division (e.g. MARKET_HALL / SHOWROOM)
  const division = scan?.presentationSection?.productCard?.salesLocation?.location?.division ?? null;

  const deptName =
    scan?.presentationSection?.productCard?.salesLocation?.location?.department?.names?.[0]?.name ??
    scan?.presentationSection?.productCard?.salesLocation?.location?.department?.title ??
    null;
  const deptId = scan?.presentationSection?.productCard?.salesLocation?.location?.department?.id ?? null;

  const itemLocationText =
    scan?.buyingInstructionSection?.salesPlaceList?.[0]?.itemLocation ??
    scan?.presentationSection?.productCard?.stockInfo?.itemLocation ??
    null;

  const itemLocationTextPlain = itemLocationText ? stripHtml(itemLocationText) : null;

  const qtyMax = scan?.buyingDecisionSection?.quantityPicker?.max ?? null;

  // Availability status & “There are X in stock…” (plus extract a number)
  const av0 = Array.isArray(avail) ? avail[0] : null;

  const avDescRaw =
    av0?.status?.description ??
    av0?.status?.text ??
    av0?.availability?.status?.description ??
    null;

  const avDesc = avDescRaw ? stripHtml(avDescRaw) : null;

  const avStatusRaw =
    av0?.status?.type ??
    av0?.status?.status ??
    av0?.status?.code ??
    av0?.availability?.status?.type ??
    av0?.availability?.status?.status ??
    null;

  const scanStatusRaw =
    scan?.presentationSection?.productCard?.product?.availability?.[0]?.status ??
    scan?.presentationSection?.productCard?.product?.availability?.status ??
    scan?.presentationSection?.productCard?.product?.availabilityStatus ??
    null;

  const stockStatus = avStatusRaw ?? scanStatusRaw ?? null;

  let avQty = null;
  if (avDesc) {
    const m = avDesc.match(/(\d[\d,]*)/);
    if (m) avQty = Number(m[1].replace(/,/g, ""));
  }

  const inStoreQty = qtyMax ?? avQty;

  return {
    article,
    market,
    lang,
    store,
    urls,

    product: {
      title: scanTitle ?? onlineTitle,
      description: scanDesc ?? onlineDesc,
      productUrl: onlineUrl,
      imageUrl: scanImg ?? onlineImg
    },

    prices: {
      online: { raw: onlineRaw, text: onlinePretty },
      store: { raw: storeRaw, text: storePretty }
    },

    stock: {
      qty: inStoreQty,
      status: stockStatus,
      description: avDescRaw,
      descriptionText: avDesc
    },

    location: {
      division,
      department: deptName,
      code: deptId,
      itemLocationText,
      itemLocationTextText: itemLocationTextPlain
    }
  };
}

// Serve static UI
app.use(express.static("public", { maxAge: "5m" }));

app.get("/api/ping", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

/**
 * GET /:article
 * Minimal HTML output for ChangeDetection.io (in-store focused)
 * Example: http://host:8088/10455151
 */
app.get("/:article(\\d{8})", async (req, res) => {
  try {
    const market = String(req.query.market || DEFAULT_MARKET).toLowerCase();
    const lang = String(req.query.lang || DEFAULT_LANG).toLowerCase();
    const store = String(req.query.store || DEFAULT_STORE);
    const article = normArticle(req.params.article);

    const data = await lookupArticle({ article, store, market, lang });

    const titleBase = data?.product?.title || `IKEA ${article}`;
    const titleDesc = data?.product?.description ? ` — ${data.product.description}` : "";
    const pageTitle = `${titleBase}${titleDesc}`;

    const qty = data?.stock?.qty;
    const status = String(data?.stock?.status || "").toUpperCase();

    let inStock = "Unknown";
    if (typeof qty === "number") inStock = qty > 0 ? "Yes" : "No";
    else if (status.includes("OUT")) inStock = "No";
    else if (status.includes("IN_STOCK") || status.includes("HIGH")) inStock = "Yes";

    const priceRaw = data?.prices?.store?.raw;
    const price = typeof priceRaw === "number" ? formatCurrencyAud(priceRaw) : "—";

    // No-cache so ChangeDetection gets fresh content each run
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Content-Type", "text/html; charset=utf-8");

    res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(pageTitle)}</title>
</head>
<body>
<pre>
In Stock: ${inStock}
Price: ${price}
Quantity: ${typeof qty === "number" ? qty : "—"}
</pre>
</body>
</html>`);
  } catch (e) {
    res.status(500).send(`Error\n${escapeHtml(e?.message || String(e))}`);
  }
});

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * GET /api/lookup?article=40492331&store=556&market=au&lang=en
 * Returns a merged object:
 *  - online price + canonical product info (product-details)
 *  - in-store price + dept/location + image (scan-shop)
 *  - store stock text + status + qty (availability)
 */
app.get("/api/lookup", async (req, res) => {
  try {
    const market = String(req.query.market || DEFAULT_MARKET).toLowerCase();
    const lang = String(req.query.lang || DEFAULT_LANG).toLowerCase();
    const store = String(req.query.store || DEFAULT_STORE);
    const article = normArticle(req.query.article);

    if (!article) {
      return res.status(400).json({ error: "Missing article. Example: /api/lookup?article=40492331" });
    }

    const result = await lookupArticle({ article, store, market, lang });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`IKEA lookup running on port ${PORT}`);
});
