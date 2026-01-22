import express from "express";

const app = express();
const PORT = Number(process.env.PORT || 8080);

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
      "accept": "application/json,text/plain,*/*",
      "user-agent": "ikea-lookup/1.0 (+server-side proxy)"
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

/**
 * Like fetchJson, but does NOT throw on non-2xx responses.
 * Useful for IKEA scan-shop which can return 503 STORE_CLOSED during end-of-day handling.
 */
async function fetchJsonInfo(url) {
  // Only cache successful JSON responses (avoid caching transient errors)
  const cached = cacheGet(url);
  if (cached) return { ok: true, status: 200, data: cached };

  const res = await fetch(url, {
    headers: {
      "accept": "application/json,text/plain,*/*",
      "user-agent": "ikea-lookup/1.0 (+server-side proxy)"
    }
  });

  const status = res.status;

  // Try JSON first (IKEA usually returns JSON for errors too), fallback to text
  let data = null;
  let text = null;
  const ct = (res.headers.get("content-type") || "").toLowerCase();

  if (ct.includes("application/json")) {
    data = await res.json().catch(() => null);
  } else {
    text = await res.text().catch(() => "");
    // Sometimes JSON is returned with odd headers
    try {
      data = JSON.parse(text);
    } catch {
      // ignore
    }
  }

  if (res.ok) {
    if (data !== null) cacheSet(url, data);
    return { ok: true, status, data };
  }

  // Preserve some readable text for debugging
  if (!text) {
    try {
      text = typeof data === "string" ? data : JSON.stringify(data);
    } catch {
      text = "";
    }
  }

  return { ok: false, status, data, text };
}

function stripHtml(input) {
  return (input ?? "").toString().replace(/<[^>]*>/g, "");
}

function isStoreClosedScanShop(respInfo) {
  if (!respInfo) return false;
  if (respInfo.ok) return false;
  if (respInfo.status !== 503) return false;

  const d = respInfo.data;
  if (d && typeof d === "object" && String(d.type || "").toUpperCase() === "STORE_CLOSED") return true;

  const t = String(respInfo.text || "");
  return t.includes("STORE_CLOSED") || t.includes("End of day");
}

function money(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  try {
    return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(Number(n));
  } catch {
    return `$${Number(n).toFixed(2)}`;
  }
}

function titleCase(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function lookupMerged({ article, store, market, lang }) {
  const urls = {
    productDetails: `https://shop.api.ingka.ikea.com/range/v6/${market}/${lang}/browse/product-details/${article}`,
    scanShop: `https://shop.api.ingka.ikea.com/scan-shop/v6/${market}/${lang}/stores/${store}/product/${article}/1`,
    availability: `https://shop.api.ingka.ikea.com/range/v6/${market}/${lang}/browse/availability/product/${article}?storeIds=${store}`
  };

  const [details, scanInfo, avail] = await Promise.all([
    fetchJson(urls.productDetails),
    fetchJsonInfo(urls.scanShop),
    fetchJson(urls.availability)
  ]);

  const scan = scanInfo.ok ? scanInfo.data : null;
  const storeClosed = isStoreClosedScanShop(scanInfo);

  // Online (market) price + canonical product info
  const onlineTitle = details?.product?.title ?? null;
  const onlineDesc = details?.product?.description ?? details?.product?.typeName ?? null;
  const onlineUrl = details?.product?.productUrl ?? null;
  const onlineImg = details?.product?.images?.[0]?.imageUrl ?? null;

  const onlineRaw = details?.product?.pricePackage?.includingVat?.rawPrice ?? null;
  const onlinePretty = details?.product?.pricePackage?.includingVat?.sellingPrice ?? null;

  // In-store (store-specific; may be unavailable if STORE_CLOSED)
  const storeRaw =
    scan?.presentationSection?.productCard?.product?.pricePackage?.includingVat?.rawPrice ??
    null;
  const storePretty =
    scan?.presentationSection?.productCard?.product?.pricePackage?.includingVat?.sellingPrice ??
    null;

  const scanTitle = scan?.presentationSection?.productCard?.product?.title ?? null;
  const scanDesc =
    scan?.presentationSection?.productCard?.product?.description ??
    scan?.presentationSection?.productCard?.product?.typeName ??
    null;

  const scanImg = scan?.presentationSection?.productCard?.product?.imageUrl ?? null;

  // ---- Division / department / location ----
  // division is on location.division (e.g., MARKET_HALL / SHOWROOM)
  const division =
    scan?.presentationSection?.productCard?.salesLocation?.location?.division ??
    null;

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

  // Many IKEA payloads include HTML tags in human strings (e.g. <b>145</b>) - keep raw, but also create plain text.
  const avDescRaw =
    av0?.status?.description ??
    av0?.status?.text ??
    av0?.availability?.status?.description ??
    av0?.availability?.status?.text ??
    null;

  const avDesc = avDescRaw ? String(avDescRaw) : null;
  const avDescPlain = avDesc ? stripHtml(avDesc) : null;

  const avStatusRaw =
    av0?.status?.code ??
    av0?.availability?.status?.code ??
    av0?.status?.type ??
    av0?.availability?.status?.type ??
    null;

  // scan-shop also carries a status code in some cases
  const scanStatusRaw =
    scan?.presentationSection?.productCard?.product?.availability?.[0]?.status ??
    scan?.presentationSection?.productCard?.product?.availability?.status ??
    scan?.presentationSection?.productCard?.product?.availabilityStatus ??
    null;

  const stockStatus = avStatusRaw ?? scanStatusRaw ?? null;

  let avQty = null;
  if (avDescPlain) {
    const m = avDescPlain.match(/(\d[\d,]*)/);
    if (m) avQty = Number(m[1].replace(/,/g, ""));
  }

  // pick a quantity:
  // - prefer numeric extracted from availability description
  // - else use scan-shop max qty if present
  const qty = avQty ?? qtyMax ?? null;

  const product = {
    title: scanTitle ?? onlineTitle ?? null,
    description: scanDesc ?? onlineDesc ?? null,
    productUrl: onlineUrl ?? null,
    imageUrl: scanImg ?? onlineImg ?? null
  };

  const result = {
    article,
    market,
    lang,
    store,
    storeClosed,
    storeClosedMessage: storeClosed
      ? ":-(" + " The store is currently closed (End of day handling). In-store price/location may be unavailable."
      : null,
    urls,
    product,
    prices: {
      online: { raw: onlineRaw, text: onlinePretty },
      store: { raw: storeRaw, text: storePretty }
    },
    stock: {
      qty,
      status: stockStatus,
      description: avDesc,
      descriptionText: avDescPlain
    },
    location: {
      division,
      department: deptName,
      code: deptId,
      itemLocationText,
      itemLocationTextText: itemLocationTextPlain
    }
  };

  // If scan-shop failed with something other than STORE_CLOSED, surface it as a normal error
  if (!scanInfo.ok && !storeClosed) {
    const debug = scanInfo.data ?? scanInfo.text ?? "";
    throw new Error(`HTTP ${scanInfo.status} from ${urls.scanShop}: ${typeof debug === "string" ? debug.slice(0, 400) : JSON.stringify(debug).slice(0, 400)}`);
  }

  return result;
}

// Serve static UI
app.use(express.static("public", { maxAge: "5m" }));

app.get("/api/ping", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

/**
 * GET /api/lookup?article=40492331&store=556&market=au&lang=en
 */
app.get("/api/lookup", async (req, res) => {
  try {
    const market = String(req.query.market || "au").toLowerCase();
    const lang = String(req.query.lang || "en").toLowerCase();
    const store = String(req.query.store || "556");
    const article = normArticle(req.query.article);

    if (!article) {
      return res.status(400).json({ error: "Missing article. Example: /api/lookup?article=40492331" });
    }

    const result = await lookupMerged({ article, store, market, lang });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

/**
 * Changedetection-friendly page:
 *   GET /10455151?store=556&market=au&lang=en
 * Server-rendered (no JS), large readable text, stable IDs for scraping.
 */
app.get("/:article([0-9\\.]+)", async (req, res) => {
  try {
    const market = String(req.query.market || "au").toLowerCase();
    const lang = String(req.query.lang || "en").toLowerCase();
    const store = String(req.query.store || "556");
    const article = normArticle(req.params.article);

    if (!article) {
      return res.status(400).send("Bad Request: missing article number.");
    }

    const data = await lookupMerged({ article, store, market, lang });

    const title = data?.product?.title ?? `IKEA article ${article}`;
    const desc = data?.product?.description ? ` — ${data.product.description}` : "";
    const pageTitle = `${title}${desc}`;

    const inStockText = (() => {
      if (data.storeClosed) return "Store closed (End of day handling)";
      const s = data?.stock?.status ?? "";
      const d = data?.stock?.descriptionText ?? "";
      if (String(s).toUpperCase().includes("OUT")) return "No";
      if (String(s).toUpperCase().includes("LOW") || String(s).toUpperCase().includes("HIGH")) return "Yes";
      // fallback based on qty
      const q = data?.stock?.qty;
      if (typeof q === "number") return q > 0 ? "Yes" : "No";
      // fallback to description text
      if (d.toLowerCase().includes("in stock")) return "Yes";
      if (d.toLowerCase().includes("out of stock")) return "No";
      return "—";
    })();

    const priceText = money(data?.prices?.store?.raw);
    const qtyText = (data?.stock?.qty ?? "—").toString();

    // Optional: include location hints
    const divPretty = data?.location?.division ? titleCase(String(data.location.division).replace(/_/g, " ")) : null;
    const dept = data?.location?.department ?? null;
    const locParts = [];
    if (divPretty) locParts.push(divPretty);
    if (dept) locParts.push(dept);
    const locText = locParts.length ? locParts.join(" • ") : "—";

    const favicon = "https://www.ikea.com/favicon.ico";

    res.setHeader("content-type", "text/html; charset=utf-8");
    res.status(200).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(pageTitle)}</title>
  <link rel="icon" href="${favicon}" />
  <link rel="shortcut icon" href="${favicon}" />
  <meta name="robots" content="noindex,nofollow" />
  <style>
    :root { color-scheme: dark; }
    body { margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; background:#0b1020; color:#fff; }
    .wrap { max-width: 900px; margin: 0 auto; padding: 28px 18px; }
    h1 { margin: 0 0 6px; font-size: 28px; font-weight: 800; letter-spacing: .2px; }
    .sub { margin: 0 0 18px; opacity: .75; font-size: 16px; }
    .banner { padding: 14px 16px; border-radius: 14px; background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.14); margin: 16px 0; font-size: 18px; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 12px; margin-top: 16px; }
    .card { padding: 18px 16px; border-radius: 16px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); }
    .label { opacity:.7; font-size: 16px; margin-bottom: 6px; }
    .value { font-size: 28px; font-weight: 900; line-height: 1.1; word-break: break-word; }
    .meta { margin-top: 10px; opacity:.7; font-size: 14px; }
    pre { margin-top: 18px; padding: 14px 16px; border-radius: 14px; background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.10); font-size: 18px; white-space: pre-wrap; }
    a { color: #9ecbff; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>${escapeHtml(pageTitle)}</h1>
    <p class="sub">Article ${escapeHtml(article)} • Store ${escapeHtml(store)} • Market ${escapeHtml(market.toUpperCase())} • Lang ${escapeHtml(lang)}</p>

    ${data.storeClosed ? `<div class="banner">${escapeHtml(data.storeClosedMessage || ":-(" + " The store is currently closed.")}</div>` : ""}

    <div class="grid">
      <div class="card">
        <div class="label">In Stock</div>
        <div class="value" id="in_stock">${escapeHtml(inStockText)}</div>
        <div class="meta">Location: <span id="location">${escapeHtml(locText)}</span></div>
      </div>

      <div class="card">
        <div class="label">Price (in-store)</div>
        <div class="value" id="price">${escapeHtml(priceText)}</div>
        <div class="meta">Raw: <span id="price_raw">${escapeHtml(String(data?.prices?.store?.raw ?? ""))}</span></div>
      </div>

      <div class="card">
        <div class="label">Quantity</div>
        <div class="value" id="quantity">${escapeHtml(qtyText)}</div>
        <div class="meta">${escapeHtml(data?.stock?.descriptionText ?? "")}</div>
      </div>
    </div>

    <pre>In Stock: ${inStockText}
Price: ${priceText}
Quantity: ${qtyText}</pre>
  </div>
</body>
</html>`);
  } catch (e) {
    // Keep it user-friendly for changedetection: return 200 with an error banner
    res.setHeader("content-type", "text/html; charset=utf-8");
    const msg = e?.message || String(e);
    res.status(200).send(`<!doctype html><html><head><meta charset="utf-8"><title>IKEA lookup error</title><link rel="icon" href="https://www.ikea.com/favicon.ico"></head><body style="font-family:system-ui;background:#0b1020;color:#fff;padding:24px;">
      <h1 style="margin:0 0 8px;">IKEA lookup</h1>
      <div style="padding:14px 16px;border-radius:14px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);font-size:18px;">
        ${escapeHtml(msg)}
      </div>
    </body></html>`);
  }
});

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

app.listen(PORT, () => {
  console.log(`IKEA lookup running on port ${PORT}`);
});
