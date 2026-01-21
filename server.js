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

function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Serve static UI
app.use(express.static("public", { maxAge: "5m" }));

app.get("/api/ping", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

/**
 * GET /api/lookup?article=40492331&store=556&market=au&lang=en
 * Returns a merged object:
 *  - online price + canonical product info (product-details)
 *  - in-store price + dept/location + image (scan-shop)
 *  - store stock text + status + qty (availability)
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

    const scanImg =
      scan?.presentationSection?.productCard?.product?.image?.url ??
      scan?.inspirationSection?.mediaCard?.imageList?.[0]?.imageUrl ??
      null;

    const division = scan?.presentationSection?.productCard?.salesLocation?.location?.division ?? null;
    const divisionPretty = division ? String(division).toLowerCase().split("_").map((w) => w ? w[0].toUpperCase() + w.slice(1) : w).join(" ") : null;
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
  null;

const avDesc = avDescRaw ? stripHtml(avDescRaw) : null;

const avStatusRaw =
  av0?.status?.type ??
  av0?.status?.status ??
  av0?.status?.code ??
  av0?.availability?.status?.type ??
  av0?.availability?.status?.status ??
  null;

// scan-shop also carries a status code in some cases
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

    const result = {
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

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});


/**
 * Simple server-rendered page for changedetection.io (in-store only).
 * Usage: http://<host>:8088/10455151
 * Optional query params: ?store=556&market=au&lang=en
 *
 * Shows: In Stock, Price, Quantity (and helpful location fields).
 * The HTML <title> uses the IKEA item title + description for nicer display in changedetection.io.
 */
app.get("/:article(\\d{6,10})", async (req, res) => {
  try {
    const market = String(req.query.market || "au").toLowerCase();
    const lang = String(req.query.lang || "en").toLowerCase();
    const store = String(req.query.store || "556");
    const article = normArticle(req.params.article);

    if (!article) {
      res.status(400);
      res.set("Content-Type", "text/html; charset=utf-8");
      return res.send("<!doctype html><title>Invalid article</title><h1>Invalid article</h1>");
    }

    const scanUrl = `https://shop.api.ingka.ikea.com/scan-shop/v6/${market}/${lang}/stores/${store}/product/${article}/1`;
    const scan = await fetchJson(scanUrl);

    const p = scan?.presentationSection?.productCard?.product ?? {};
    const stockInfo = scan?.presentationSection?.productCard?.stockInfo ?? {};

    const titleShort = p?.title ?? article;
    const desc = p?.description ?? p?.typeName ?? "";
    const fullTitle = (titleShort && desc) ? `${titleShort} ${desc}` : (titleShort || desc || article);

    const priceText = p?.pricePackage?.includingVat?.sellingPrice ?? null;
    const priceRaw = p?.pricePackage?.includingVat?.rawPrice ?? null;

    const qty = scan?.buyingDecisionSection?.quantityPicker?.max ?? null;

    const division = scan?.presentationSection?.productCard?.salesLocation?.location?.division ?? null;
    const deptName =
      scan?.presentationSection?.productCard?.salesLocation?.location?.department?.names?.[0]?.name ??
      scan?.presentationSection?.productCard?.salesLocation?.location?.department?.title ??
      null;
    const deptId = scan?.presentationSection?.productCard?.salesLocation?.location?.department?.id ?? null;

    const itemLocationText =
      scan?.buyingInstructionSection?.salesPlaceList?.[0]?.itemLocation ??
      null;

    const html = `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(fullTitle)}</title>
  <style>
    body{font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin:16px; line-height:1.35;}
    h1{font-size:18px; margin:0 0 10px;}
    .kv{margin:0; padding:0; list-style:none;}
    .kv li{padding:6px 0; border-bottom:1px solid rgba(0,0,0,.08);}
    .k{font-weight:600; display:inline-block; min-width:92px;}
    .muted{color:rgba(0,0,0,.65); font-size:12px; margin-top:10px;}
    code{background:rgba(0,0,0,.06); padding:2px 6px; border-radius:6px;}
  </style>
</head>
<body>
  <h1>${escapeHtml(fullTitle)}</h1>

  <ul class="kv">
    <li><span class="k">In Stock:</span> ${escapeHtml(stockInfo?.text ?? "Unknown")} <span class="muted">(${escapeHtml(stockInfo?.code ?? "UNKNOWN")})</span></li>
    <li><span class="k">Price:</span> ${escapeHtml(priceText ?? "N/A")} <span class="muted">${priceRaw != null ? `(raw: ${escapeHtml(priceRaw)})` : ""}</span></li>
    <li><span class="k">Quantity:</span> ${qty != null ? escapeHtml(qty) : "N/A"}</li>
  </ul>

  <div class="muted" style="margin-top:12px;">
    Article: <code>${escapeHtml(article)}</code> &nbsp;|&nbsp; Store: <code>${escapeHtml(store)}</code>
    ${division ? `&nbsp;|&nbsp; Division: <code>${escapeHtml(divisionPretty)}</code>` : ""}
    ${deptName ? `&nbsp;|&nbsp; Dept: <code>${escapeHtml(deptName)}</code>` : ""}
    ${deptId ? `&nbsp;|&nbsp; Dept ID: <code>${escapeHtml(deptId)}</code>` : ""}
    ${itemLocationText ? `<br/>Location note: ${escapeHtml(stripHtml(itemLocationText))}` : ""}
  </div>
</body>
</html>`;

    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (e) {
    res.status(500);
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html><title>Error</title><h1>Error</h1><pre>${escapeHtml(e?.message || String(e))}</pre>`);
  }
});

app.listen(PORT, () => {
  console.log(`IKEA lookup running on port ${PORT}`);
});
