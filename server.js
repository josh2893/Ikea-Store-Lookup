import express from "express";
import { createRequire } from "module";

// Optional: used to source the official store list (400+ stores worldwide)
// We only use it for Australia dropdown options.
const require = createRequire(import.meta.url);
let ikeaChecker = null;
try {
  ikeaChecker = require("ikea-availability-checker");
} catch {
  // If dependency isn't installed for some reason, we fall back to a minimal embedded list.
  ikeaChecker = null;
}

const app = express();
const PORT = Number(process.env.PORT || 8080);
const DEFAULT_STORE = String(process.env.DEFAULT_STORE || "556");

// Ingka API client-id used by ikea-availability-checker (can be overridden)
const INGKA_CLIENT_ID = String(process.env.INGKA_CLIENT_ID || \"da465052-7912-43b2-82fa-9dc39cdccef8\");


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

function cacheSet(key, value, ttlMs = CACHE_TTL_MS) {
  cache.set(key, { expires: Date.now() + ttlMs, value });
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

// ---- Ingka CIA (api.ingka.ikea.com) fetch (requires x-client-id + versioned accept header) ----

async function fetchIngkaJson(url) {
  const key = `ingka:${url}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const res = await fetch(url, {
    headers: {
      "x-client-id": INGKA_CLIENT_ID,
      "accept": "application/json;version=1",
      "user-agent": "ikea-lookup/1.0 (+server-side proxy)"
    }
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${url}: ${txt.slice(0, 400)}`);
  }

  const data = await res.json();
  cacheSet(key, data);
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

// ---- Ingka CIA fetch (requires x-client-id + versioned accept) ----
async function fetchJsonCia(url) {
  const key = `cia:${url}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const res = await fetch(url, {
    headers: {
      "x-client-id": INGKA_CLIENT_ID,
      "accept": "application/json;version=1",
      "user-agent": "ikea-lookup/1.0 (+server-side proxy)"
    }
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${url}: ${txt.slice(0, 400)}`);
  }

  const data = await res.json();
  cacheSet(key, data);
  return data;
}

function pick(obj, path, fallback=null) {
  try {
    let cur = obj;
    for (const k of path) {
      if (cur == null) return fallback;
      cur = cur[k];
    }
    return cur == null ? fallback : cur;
  } catch {
    return fallback;
  }
}

function extractCiaOption(opt) {
  const inRange = !!pick(opt, ["range", "inRange"], false);
  const reasonRaw = pick(opt, ["range", "reason"], null);
  const reasonCode = reasonRaw ? (reasonRaw.code ?? null) : null;

  const status = pick(opt, ["availability", "probability", "thisDay", "messageType"], null);
  const qty = pick(opt, ["availability", "quantity"], null);

  const restocksRaw = pick(opt, ["availability", "restocks"], []);
  const restocks = Array.isArray(restocksRaw)
    ? restocksRaw.map(r => ({
        earliestDate: r?.earliestDate ?? null,
        latestDate: r?.latestDate ?? null,
        quantity: r?.quantity ?? null,
        reliability: r?.reliability ?? null,
        type: r?.type ?? null,
        updateDateTime: r?.updateDateTime ?? null
      }))
    : [];

  return {
    inRange,
    status,
    qty,
    reason: (reasonRaw || reasonCode) ? { code: reasonCode, raw: reasonRaw } : null,
    restocks
  };
}

function parseCiaForSelectedStore(cia, { itemNo, storeCode }) {
  const av = Array.isArray(cia?.availabilities) ? cia.availabilities : [];
  const storeEntry = av.find(a =>
    String(a?.itemKey?.itemNo ?? "") === String(itemNo) &&
    String(a?.classUnitKey?.classUnitType ?? "") === "STO" &&
    String(a?.classUnitKey?.classUnitCode ?? "") === String(storeCode)
  );

  if (!storeEntry) return null;

  return {
    store: {
      id: String(storeCode),
      name: storeEntry?.classUnitKey?.classUnitName ?? null
    },
    itemNo: String(itemNo),
    cashCarry: extractCiaOption(storeEntry?.buyingOption?.cashCarry),
    clickCollect: extractCiaOption(storeEntry?.buyingOption?.clickCollect),
    homeDelivery: extractCiaOption(storeEntry?.buyingOption?.homeDelivery),
    eligibleForStockNotification: storeEntry?.eligibleForStockNotification ?? null
  };
}

async function fetchCiaAvailabilities({ itemNo, countryCode="au", unitType="ru" }) {
  const url = `https://api.ingka.ikea.com/cia/availabilities/${unitType}/${countryCode}?itemNos=${encodeURIComponent(itemNo)}&expand=StoresList,Restocks`;
  return await fetchJsonCia(url);
}

// ---- Text fetch (HTML) ----
async function fetchText(url) {
  const key = `text:${url}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const res = await fetch(url, {
    headers: {
      "accept": "text/html,*/*",
      "user-agent": "ikea-lookup/1.0 (+server-side proxy)"
    }
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${url}: ${txt.slice(0, 200)}`);
  }

  const html = await res.text();
  cacheSet(key, html);
  return html;
}

function slugifyStoreName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function decodeHtmlEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Store hours (HTML scrape) cache: 6h by default
const STORE_HOURS_TTL_MS = Number(process.env.STORE_HOURS_TTL_MS || 6 * 60 * 60 * 1000);
const storeHoursCache = new Map(); // slug -> { expires, value }

function storeHoursGet(slug) {
  const v = storeHoursCache.get(slug);
  if (!v) return null;
  if (Date.now() > v.expires) {
    storeHoursCache.delete(slug);
    return null;
  }
  return v.value;
}

function storeHoursSet(slug, value) {
  storeHoursCache.set(slug, { expires: Date.now() + STORE_HOURS_TTL_MS, value });
  if (storeHoursCache.size > 200) {
    const firstKey = storeHoursCache.keys().next().value;
    if (firstKey) storeHoursCache.delete(firstKey);
  }
}

function parseStoreHoursFromHtml(html) {
  // Target the block: <div class="hnf-store__container__block"> ... <h2>Store</h2> ... <dl>...</dl>
  const blockRe = /<div[^>]*class=["'][^"']*hnf-store__container__block[^"']*["'][^>]*>[\s\S]*?<h2[^>]*>\s*Store\s*<\/h2>[\s\S]*?<dl[^>]*>([\s\S]*?)<\/dl>/i;
  const bm = String(html || "").match(blockRe);
  if (!bm) return [];

  const dl = bm[1] || "";
  const items = [];
  const pairRe = /<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;
  let m;
  while ((m = pairRe.exec(dl))) {
    const days = decodeHtmlEntities(stripHtml(m[1]));
    const hours = decodeHtmlEntities(stripHtml(m[2]));
    if (days && hours) items.push({ days, hours });
  }
  return items;
}

async function getStoreHours(slug) {
  const cached = storeHoursGet(slug);
  if (cached) return cached;

  const url = `https://www.ikea.com/au/en/stores/${slug}/`;
  const html = await fetchText(url);
  const hours = parseStoreHoursFromHtml(html);
  const value = { slug, url, hours };
  storeHoursSet(slug, value);
  return value;
}

function stripHtml(input) {
  return (input ?? "").toString().replace(/<[^>]*>/g, "");
}

function parseNumberLike(s) {
  if (s === null || s === undefined) return null;
  const n = Number(String(s).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function isLikelyYear(n) {
  return typeof n === "number" && n >= 2000 && n <= 2100;
}

/**
 * Try to extract a stock quantity from human text.
 * Avoids picking up years like 2026 from strings such as "Price valid ... 2026 ...".
 */
function extractQtyFromText(text) {
  if (!text) return null;
  const t = String(text).replace(/\s+/g, " ").trim();

  const contextual = [
    /there (?:are|is)\s+(\d[\d,]*)/i,
    /(\d[\d,]*)\s+(?:in stock|available|left)\b/i,
    /in stock[:\s]+(\d[\d,]*)/i,
    /stock[:\s]+(\d[\d,]*)/i
  ];

  for (const re of contextual) {
    const m = t.match(re);
    if (m) {
      const n = parseNumberLike(m[1]);
      if (n !== null && !isLikelyYear(n)) return n;
    }
  }

  const nums = [];
  for (const m of t.matchAll(/\b(\d[\d,]*)\b/g)) {
    const n = parseNumberLike(m[1]);
    if (n !== null && !isLikelyYear(n)) nums.push(n);
  }
  if (!nums.length) return null;
  if (nums.length === 1) return nums[0];
  return null;
}


function numberFixed(n, decimals = 2) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  return x.toFixed(decimals);
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

// ---- CIA helpers (api.ingka.ikea.com) ----
function pickPrimaryRestock(restocks) {
  if (!Array.isArray(restocks) || !restocks.length) return null;
  const sorted = [...restocks].sort((a, b) => {
    const ae = String(a?.earliestDate || "");
    const be = String(b?.earliestDate || "");
    if (ae !== be) return ae.localeCompare(be);
    const al = String(a?.latestDate || "");
    const bl = String(b?.latestDate || "");
    return al.localeCompare(bl);
  });
  return sorted[0] || null;
}

function normCiaOption(opt) {
  const inRange = opt?.range?.inRange ?? null;
  const reason = opt?.range?.reason ?? null;
  const messageType = opt?.availability?.probability?.thisDay?.messageType ?? null;
  const quantity = opt?.availability?.quantity ?? null;
  const restocks = Array.isArray(opt?.availability?.restocks) ? opt.availability.restocks : [];

  return {
    inRange,
    messageType,
    quantity,
    restocks,
    primaryRestock: pickPrimaryRestock(restocks),
    reason: reason
      ? { code: reason?.code ?? null, name: reason?.name ?? null, raw: reason }
      : null,
    rangeRaw: opt?.range ?? null
  };
}

function summarizeCia(ciaData, { store, article }) {
  const list = Array.isArray(ciaData?.availabilities) ? ciaData.availabilities : [];

  const storeEntry =
    list.find((a) =>
      String(a?.itemKey?.itemNo) === String(article) &&
      String(a?.classUnitKey?.classUnitType) === "STO" &&
      String(a?.classUnitKey?.classUnitCode) === String(store)
    ) || null;

  const ruEntry =
    list.find((a) =>
      String(a?.itemKey?.itemNo) === String(article) &&
      String(a?.classUnitKey?.classUnitType) === "RU" &&
      String(a?.classUnitKey?.classUnitCode) === "AU"
    ) || null;

  const storeBuying = storeEntry?.buyingOption ?? null;
  const ruBuying = ruEntry?.buyingOption ?? null;

  const storeNorm = storeBuying
    ? {
        cashCarry: normCiaOption(storeBuying.cashCarry),
        clickCollect: normCiaOption(storeBuying.clickCollect),
        homeDelivery: normCiaOption(storeBuying.homeDelivery)
      }
    : null;

  const ruNorm = ruBuying
    ? {
        cashCarry: normCiaOption(ruBuying.cashCarry),
        clickCollect: normCiaOption(ruBuying.clickCollect),
        homeDelivery: normCiaOption(ruBuying.homeDelivery)
      }
    : null;

  function computeDisplay(opt) {
    const available = opt?.inRange === true;
    const reasonCode = available ? null : (opt?.reason?.code ?? null);
    const reasonRaw = available ? null : (opt?.reason?.raw ?? opt?.rangeRaw ?? null);
    const status = available ? (opt?.messageType ?? null) : "UNAVAILABLE";
    return {
      available,
      status,
      reasonCode,
      reasonRaw,
      quantity: opt?.quantity ?? null,
      primaryRestock: opt?.primaryRestock ?? null
    };
  }

  const computed = storeNorm
    ? {
        inStore: computeDisplay(storeNorm.cashCarry),
        clickCollect: computeDisplay(storeNorm.clickCollect),
        homeDelivery: computeDisplay(storeNorm.homeDelivery)
      }
    : null;

  return {
    store: storeEntry
      ? {
          type: storeEntry?.classUnitKey?.classUnitType ?? "STO",
          code: storeEntry?.classUnitKey?.classUnitCode ?? String(store),
          name: storeEntry?.classUnitKey?.classUnitName ?? null,
          buyingOption: storeNorm
        }
      : null,
    ru: ruEntry
      ? {
          type: ruEntry?.classUnitKey?.classUnitType ?? "RU",
          code: ruEntry?.classUnitKey?.classUnitCode ?? "AU",
          name: ruEntry?.classUnitKey?.classUnitName ?? "Australia",
          buyingOption: ruNorm
        }
      : null,
    computed
  };
}

async function lookupMerged({ article, store, market, lang }) {
  
const urls = {
  productDetails: `https://shop.api.ingka.ikea.com/range/v6/${market}/${lang}/browse/product-details/${article}`,
  scanShop: `https://shop.api.ingka.ikea.com/scan-shop/v6/${market}/${lang}/stores/${store}/product/${article}/1`,
  availability: `https://shop.api.ingka.ikea.com/range/v6/${market}/${lang}/browse/availability/product/${article}?storeIds=${store}`,
  cia: `https://api.ingka.ikea.com/cia/availabilities/ru/${market}?itemNos=${article}&expand=StoresList,Restocks`
};

  
const [details, scanInfo, avail, ciaRes] = await Promise.all([
  fetchJson(urls.productDetails),
  fetchJsonInfo(urls.scanShop),
  fetchJson(urls.availability),
  fetchIngkaJson(urls.cia)
    .then((data) => ({ ok: true, data }))
    .catch((e) => ({ ok: false, error: e?.message || String(e) }))
]);

const cia = ciaRes?.ok ? summarizeCia(ciaRes.data, { store, article }) : null;

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

  // Human-friendly floor/department/code split (for UI pills)
  const floorPretty = division ? titleCase(String(division).replace(/_/g, " ")) : null;

  // Many items include a location code like SPS007 inside the itemLocationText.
  let locationCode = deptId;
  const codeMatch = String(itemLocationTextPlain || "").match(/\b[A-Z]{2,5}\d{2,5}\b/);
  if (codeMatch) locationCode = codeMatch[0];

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

  let avQty = extractQtyFromText(avDescPlain);

  // pick a quantity:
  // - prefer numeric extracted from availability description (ignoring years)
  // - else use scan-shop max qty if present (often 0 when out of stock)
  const statusUpper = String(stockStatus || "").toUpperCase();
  const qty = statusUpper.includes("OUT") ? 0 : (avQty ?? qtyMax ?? null);

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
      floor: floorPretty,
      department: deptName,
      code: locationCode,
      itemLocationText,
      itemLocationTextText: itemLocationTextPlain
    },
    cia: {
      ok: Boolean(ciaRes?.ok),
      error: ciaRes?.ok ? null : (ciaRes?.error ?? "CIA unavailable"),
      url: urls.cia,
      summary: cia
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

// Minimal AU fallback list (only used if ikea-availability-checker isn't available)
const FALLBACK_AU_STORES = [
  // Perth is included as a sensible default because it's commonly used in examples.
  // Full AU store list comes from the ikea-availability-checker dependency.
  { id: "556", name: "Perth", slug: "perth" }
];

/**
 * Store list for dropdown
 * GET /api/stores?country=au
 */
app.get("/api/stores", (req, res) => {
  const countryCode = String(req.query.country || "au").toLowerCase();

  try {
    let stores = [];
    if (ikeaChecker?.stores?.findByCountryCode) {
      stores = ikeaChecker.stores.findByCountryCode(countryCode) || [];
      stores = stores
        .map((s) => {
          const id = String(s?.buCode ?? s?.storeId ?? s?.id ?? "").trim();
          const name = String(s?.name ?? "").trim();
          if (!id || !name) return null;
          const slug = slugifyStoreName(name);
          return {
            id,
            name,
            slug,
            countryCode: String(s?.countryCode ?? countryCode).toLowerCase(),
            country: s?.country ?? (countryCode === "au" ? "Australia" : undefined),
            url: `https://www.ikea.com/${countryCode}/en/stores/${slug}/`
          };
        })
        .filter(Boolean);
    } else {
      stores = FALLBACK_AU_STORES;
    }

    // If we're in AU, keep only AU stores (in case the checker returns more)
    if (countryCode === "au") stores = stores.filter((s) => String(s.countryCode || "").toLowerCase() === "au");

    stores.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    res.json({ ok: true, countryCode, country: countryCode === "au" ? "Australia" : undefined, stores });
  } catch (e) {
    res.json({ ok: true, countryCode, country: countryCode === "au" ? "Australia" : undefined, stores: FALLBACK_AU_STORES });
  }
});

/**
 * Store opening hours (scraped from https://www.ikea.com/au/en/stores/<slug>/)
 * GET /api/store-hours/perth
 */
app.get("/api/store-hours/:slug", async (req, res) => {
  try {
    const slug = slugifyStoreName(req.params.slug);
    if (!slug) return res.status(400).json({ error: "Missing store slug" });
    const data = await getStoreHours(slug);
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/**
 * GET /api/lookup?article=40492331&store=556&market=au&lang=en
 */
app.get("/api/lookup", async (req, res) => {
  try {
    const market = String(req.query.market || "au").toLowerCase();
    const lang = String(req.query.lang || "en").toLowerCase();
    const store = String(req.query.store || DEFAULT_STORE);
    const article = normArticle(req.query.article);

    if (!article) {
      return res.status(400).json({ error: "Missing article. Example: /api/lookup?article=40492331" });
    }

    const result = await lookupMerged({ article, store, market, lang });

    // CIA availabilities (home delivery / click & collect / restocks / range reason codes)
    try {
      const ciaRaw = await fetchCiaAvailabilities({ itemNo: article, countryCode: market, unitType: "ru" });
      result.cia = parseCiaForSelectedStore(ciaRaw, { itemNo: article, storeCode: store });
    } catch (e) {
      result.cia = null;
      result.ciaError = e?.message || String(e);
    }

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

async function renderChangedetectionPage(req, res, { store, article }) {
  const market = String(req.query.market || "au").toLowerCase();
  const lang = String(req.query.lang || "en").toLowerCase();

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

  const priceRaw = data?.prices?.store?.raw;
  const priceText = money(priceRaw);
  const priceNumber = numberFixed(priceRaw, 2);
  const priceNumberMeta = priceNumber === "—" ? "" : priceNumber;
  const qtyText = (data?.stock?.qty ?? "—").toString();

  const schemaAvailability =
    inStockText === "Yes" ? "https://schema.org/InStock" :
    inStockText === "No" ? "https://schema.org/OutOfStock" :
    "https://schema.org/Discontinued";

  const productLd = {
    "@context": "https://schema.org/",
    "@type": "Product",
    "name": pageTitle,
    "sku": article,
    "image": data?.product?.imageUrl ? [data.product.imageUrl] : undefined,
    "url": data?.product?.productUrl ?? undefined,
    "offers": {
      "@type": "Offer",
      "priceCurrency": "AUD",
      "price": Number.isFinite(Number(priceRaw)) ? Number(priceRaw).toFixed(2) : undefined,
      "availability": schemaAvailability
    }
  };

  const productLdJson = JSON.stringify(productLd).replace(/</g, "\\u003c");

  const floor = data?.location?.floor ?? null;
  const dept = data?.location?.department ?? null;
  const code = data?.location?.code ?? null;
  const locParts = [];
  if (floor) locParts.push(floor);
  if (dept) locParts.push(dept);
  if (code) locParts.push(code);
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
  <meta property="product:price:amount" content="${escapeHtml(priceNumberMeta)}" />
  <meta property="product:price:currency" content="AUD" />
  <meta property="product:availability" content="${escapeHtml(schemaAvailability)}" />
  <script type="application/ld+json">${productLdJson}</script>
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
        <div class="meta">Numeric: <span id="price_number">${escapeHtml(priceNumber)}</span> • Raw: <span id="price_raw">${escapeHtml(String(priceRaw ?? ""))}</span></div>
      </div>

      <div class="card">
        <div class="label">Quantity</div>
        <div class="value" id="quantity">${escapeHtml(qtyText)}</div>
        <div class="meta">${escapeHtml(data?.stock?.descriptionText ?? "")}</div>
      </div>
    </div>

    <pre id="cd_pre">In Stock: ${inStockText}
Price: ${priceNumber}
Quantity: ${qtyText}</pre>
  </div>
</body>
</html>`);
}

/**
 * Changedetection-friendly page:
 *   GET /<storeId>/<articleId>
 *   Example: /556/10455151
 * Server-rendered (no JS), large readable text, stable IDs for scraping.
 */
app.get("/:store([0-9]+)/:article([0-9\\.]+)", async (req, res) => {
  try {
    const store = String(req.params.store || DEFAULT_STORE);
    const article = normArticle(req.params.article);
    if (!article) return res.status(400).send("Bad Request: missing article number.");
    await renderChangedetectionPage(req, res, { store, article });
  } catch (e) {
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

app.get("/:article([0-9\\.]+)", async (req, res) => {
  try {
    const article = normArticle(req.params.article);

    if (!article) {
      return res.status(400).send("Bad Request: missing article number.");
    }
    // Backwards-compat: /<article>?store=556
    const store = String(req.query.store || DEFAULT_STORE);
    await renderChangedetectionPage(req, res, { store, article });
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
