// fxebay — Cloudflare Worker that serves Discord-friendly embeds for eBay listings.
//
// Swap "ebay.com" for your worker's domain in any item link:
//   https://www.ebay.com/itm/117298301199  ->  https://<your-worker>/itm/117298301199
// Embed crawlers (Discordbot etc.) get Open Graph tags; humans get redirected to eBay.

const BOT_UA =
  /discordbot|twitterbot|facebookexternalhit|telegrambot|slackbot|whatsapp|mastodon|embedly|skypeuripreview|redditbot|linkedinbot|cardyb|bluesky|iframely|vkshare|pinterest|googlebot|bingbot/i;

const EBAY_GREEN = "#86b817";
const CACHE_TTL = 600; // seconds

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" || path === "") {
      return Response.redirect(env.HOME_URL || "https://github.com", 302);
    }
    if (path === "/oembed.json") return oembed(url);
    if (path === "/favicon.ico" || path === "/robots.txt") return new Response(null, { status: 404 });

    let itemId;
    try {
      itemId = await resolveItemId(url, env);
    } catch (e) {
      return text(`Couldn't resolve that link: ${e.message}`, 400);
    }
    if (!itemId) return text("No eBay item ID found in that URL.", 400);

    const ebayUrl = `https://www.ebay.com/itm/${itemId}`;
    const ua = request.headers.get("user-agent") || "";
    const forceEmbed = url.searchParams.has("embed");
    if (!BOT_UA.test(ua) && !forceEmbed) return Response.redirect(ebayUrl, 302);

    let item;
    try {
      item = await getItem(itemId, env, ctx, url.origin);
    } catch (e) {
      console.log(`item ${itemId} failed: ${e.message}`);
    }
    if (!item) {
      item = { id: itemId, title: `eBay item ${itemId}`, url: ebayUrl, description: "Couldn't load listing details." };
    }

    return new Response(renderEmbed(item, url.origin), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": `public, max-age=${CACHE_TTL}`,
      },
    });
  },
};

// ---------- URL handling ----------

async function resolveItemId(url, env) {
  const path = decodeURIComponent(url.pathname);

  // ebay.us short links: https://ebay.us/m/AbC123 -> /m/AbC123 (or /AbC123)
  const short = path.match(/^\/(m\/)?([A-Za-z0-9]{4,12})\/?$/);
  if (short && !/^\d+$/.test(short[2])) {
    const code = `${short[1] || ""}${short[2]}`;
    const res = await fetch(`https://ebay.us/${code}`, { redirect: "manual" });
    let loc = res.headers.get("location");
    if (!loc && env.FETCHER_URL) {
      const r = await fetcher(`/short/${code}`, env);
      if (r.ok) loc = (await r.json()).location;
    }
    if (!loc) throw new Error("short link didn't redirect");
    return extractItemId(loc);
  }

  return extractItemId(path + url.search);
}

export function extractItemId(s) {
  const itm = s.match(/\/itm\/(?:[^/?#]+\/)?(\d{9,15})/);
  if (itm) return itm[1];
  const q = s.match(/[?&](?:item|itemId|iid)=(\d{9,15})/i);
  if (q) return q[1];
  const bare = s.match(/^\/(\d{9,15})\/?(?:[?#]|$)/);
  return bare ? bare[1] : null;
}

// ---------- data ----------

async function getItem(itemId, env, ctx, origin) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(`${origin}/__cache/item/${itemId}`);
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit.json();
    } catch (e) {
      console.log(`cache read: ${e.message}`);
    }
  }

  let item = null;
  if (env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET) {
    item = await fromBrowseApi(itemId, env).catch((e) => console.log(`api: ${e.message}`));
  }
  if (!item && env.FETCHER_URL) {
    item = await fromFetcher(itemId, env).catch((e) => console.log(`fetcher: ${e.message}`));
  }
  if (!item) item = await fromScrape(itemId);

  if (item && cache) {
    const res = new Response(JSON.stringify(item), {
      headers: { "content-type": "application/json", "cache-control": `max-age=${CACHE_TTL}` },
    });
    ctx?.waitUntil?.(cache.put(cacheKey, res).catch((e) => console.log(`cache write: ${e.message}`)));
  }
  return item;
}

let tokenCache = { token: null, expires: 0 };

async function getAppToken(env) {
  if (tokenCache.token && Date.now() < tokenCache.expires - 60_000) return tokenCache.token;
  const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: "Basic " + btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`),
    },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  if (!res.ok) throw new Error(`token request failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  tokenCache = { token: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function browse(path, env) {
  const token = await getAppToken(env);
  return fetch(`https://api.ebay.com/buy/browse/v1/${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      "x-ebay-c-marketplace-id": env.EBAY_MARKETPLACE || "EBAY_US",
    },
  });
}

async function fromBrowseApi(itemId, env) {
  let res = await browse(`item/get_item_by_legacy_id?legacy_item_id=${itemId}`, env);
  if (res.ok) return normalizeApiItem(await res.json(), itemId);

  // Listings with variations (sizes/colours) must be fetched as an item group.
  const err = await res.json().catch(() => ({}));
  const isGroup = (err.errors || []).some((e) => e.errorId === 11006);
  if (!isGroup) throw new Error(`browse api ${res.status}: ${JSON.stringify(err).slice(0, 300)}`);

  res = await browse(`item/get_items_by_item_group?item_group_id=${itemId}`, env);
  if (!res.ok) throw new Error(`browse api group ${res.status}`);
  const group = await res.json();
  const items = group.items || [];
  if (!items.length) return null;
  const base = normalizeApiItem(items[0], itemId);
  const prices = items.map((i) => Number(i.price?.value)).filter((n) => !isNaN(n));
  if (prices.length > 1) {
    const lo = Math.min(...prices), hi = Math.max(...prices);
    if (lo !== hi) base.price = `${money(lo, items[0].price.currency)} – ${money(hi, items[0].price.currency)}`;
  }
  base.variations = items.length;
  return base;
}

export function normalizeApiItem(d, itemId) {
  const auction = (d.buyingOptions || []).includes("AUCTION");
  const priceObj = auction && d.currentBidPrice ? d.currentBidPrice : d.price;
  const ship = d.shippingOptions?.[0]?.shippingCost;
  const loc = d.itemLocation;
  const images = [d.image?.imageUrl, ...(d.additionalImages || []).map((i) => i.imageUrl)].filter(Boolean);

  return {
    id: itemId,
    url: `https://www.ebay.com/itm/${itemId}`,
    title: d.title,
    price: priceObj ? money(priceObj.value, priceObj.currency) : null,
    auction,
    bids: auction ? d.bidCount ?? 0 : null,
    buyItNow: auction && (d.buyingOptions || []).includes("FIXED_PRICE") && d.price ? money(d.price.value, d.price.currency) : null,
    endsAt: d.itemEndDate || null,
    condition: d.condition || null,
    shipping: ship ? (Number(ship.value) === 0 ? "Free shipping" : `+${money(ship.value, ship.currency)} shipping`) : null,
    location: loc ? [loc.city, loc.stateOrProvince, loc.country].filter(Boolean).join(", ") : null,
    seller: d.seller?.username || null,
    feedback: d.seller ? { pct: d.seller.feedbackPercentage, score: d.seller.feedbackScore } : null,
    description: d.shortDescription || null,
    images: hiRes(images).slice(0, 4),
    soldOut: d.estimatedAvailabilities?.[0]?.estimatedAvailabilityStatus === "OUT_OF_STOCK",
  };
}

// The fetcher (../fetcher/app.py) fetches with a browser TLS fingerprint, which eBay accepts.
function fetcher(path, env) {
  // trim() also strips the BOM that Windows PowerShell adds when piping into `wrangler secret put`.
  return fetch(env.FETCHER_URL.trim().replace(/\/$/, "") + path, {
    headers: { authorization: `Bearer ${(env.FETCHER_TOKEN || "").trim()}` },
  });
}

async function fromFetcher(itemId, env) {
  const res = await fetcher(`/item/${itemId}`, env);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return parseItemHtml(await res.text(), itemId);
}

// Best effort: eBay 403s the Workers runtime's TLS fingerprint, so this rarely works.
async function fromScrape(itemId) {
  const res = await fetch(`https://www.ebay.com/itm/${itemId}`, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) Gecko/20100101 Firefox/158.0",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.5",
    },
  });
  if (!res.ok) return null;
  return parseItemHtml(await res.text(), itemId);
}

export function parseItemHtml(html, itemId) {
  const meta = (prop) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, "i");
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, "i");
    const m = html.match(re) || html.match(re2);
    return m ? decodeEntities(m[1]) : null;
  };

  let ld = null;
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1]);
      const found = [].concat(j, j["@graph"] || []).find((x) => x?.["@type"] === "Product");
      if (found) { ld = found; break; }
    } catch {}
  }

  const title = ld?.name || meta("og:title") || meta("twitter:title");
  if (!title || /error page/i.test(title)) return null;

  const offer = Array.isArray(ld?.offers) ? ld.offers[0] : ld?.offers;
  const imgs = [].concat(ld?.image || meta("og:image") || []).map((i) => (typeof i === "string" ? i : i?.url)).filter(Boolean);
  const rate = [].concat(offer?.shippingDetails || [])[0]?.shippingRate;

  return {
    id: itemId,
    url: `https://www.ebay.com/itm/${itemId}`,
    title: title.replace(/\s*\|\s*eBay\s*$/i, ""),
    price: offer?.price ? money(offer.price, offer.priceCurrency) : null,
    condition: offer?.itemCondition ? String(offer.itemCondition).split("/").pop().replace(/Condition$/, "") : null,
    shipping: rate ? (Number(rate.value) === 0 ? "Free shipping" : `+${money(rate.value, rate.currency)} shipping`) : null,
    soldOut: /OutOfStock|SoldOut/i.test(offer?.availability || ""),
    description: meta("og:description"),
    images: hiRes(imgs).slice(0, 4),
  };
}

// ---------- rendering ----------

export function renderEmbed(item, origin) {
  const lines = [];
  const priceBits = [];
  if (item.price) priceBits.push(`💲 ${item.price}`);
  if (item.auction) priceBits.push(`🔨 ${item.bids} bid${item.bids === 1 ? "" : "s"}`);
  if (item.buyItNow) priceBits.push(`Buy It Now ${item.buyItNow}`);
  if (priceBits.length) lines.push(priceBits.join(" · "));

  const info = [item.condition, item.shipping].filter(Boolean);
  if (info.length) lines.push(info.join(" · "));
  if (item.variations) lines.push(`${item.variations} variations`);
  if (item.endsAt && item.auction) lines.push(`⏰ Ends ${new Date(item.endsAt).toUTCString().replace(":00 GMT", " UTC")}`);
  if (item.soldOut) lines.push("❌ Out of stock");
  if (item.location) lines.push(`📍 ${item.location}`);
  if (item.description) {
    if (lines.length) lines.push("");
    lines.push(truncate(decodeEntities(item.description.replace(/<[^>]*>/g, " ")), 250));
  }

  const desc = lines.join("\n");
  const img = item.images?.[0];
  const author = item.seller
    ? `${item.seller}${item.feedback?.score != null ? ` (${item.feedback.score}${item.feedback.pct ? ` · ${item.feedback.pct}%` : ""})` : ""}`
    : null;

  const oembedUrl = `${origin}/oembed.json?` + new URLSearchParams({
    title: item.title,
    author: author || "",
    url: item.url,
  });

  const tags = [
    `<meta charset="utf-8">`,
    `<title>${esc(item.title)}</title>`,
    `<meta name="theme-color" content="${EBAY_GREEN}">`,
    `<meta property="og:site_name" content="eBay">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="${esc(item.url)}">`,
    `<meta property="og:title" content="${esc(item.title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta name="twitter:title" content="${esc(item.title)}">`,
    `<meta name="twitter:description" content="${esc(desc)}">`,
    ...(item.images || []).map((u) => `<meta property="og:image" content="${esc(u)}">`),
    img ? `<meta name="twitter:card" content="summary_large_image">` : "",
    img ? `<meta name="twitter:image" content="${esc(img)}">` : "",
    `<link rel="alternate" type="application/json+oembed" href="${esc(oembedUrl)}">`,
    `<meta http-equiv="refresh" content="0; url=${esc(item.url)}">`,
  ];

  return `<!doctype html><html><head>${tags.filter(Boolean).join("\n")}</head><body><a href="${esc(item.url)}">View on eBay</a></body></html>`;
}

function oembed(url) {
  const p = url.searchParams;
  const body = {
    version: "1.0",
    type: "link",
    title: p.get("title") || "",
    provider_name: "eBay",
    provider_url: p.get("url") || "https://www.ebay.com",
  };
  if (p.get("author")) {
    body.author_name = `Seller: ${p.get("author")}`;
    body.author_url = p.get("url");
  }
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

// ---------- helpers ----------

// eBay image URLs end in s-l<size>.<ext>; ask for the 1600px version.
function hiRes(urls) {
  return urls.map((u) => u.replace(/s-l\d+\.(jpg|jpeg|png|webp)/i, "s-l1600.$1"));
}

function money(value, currency) {
  const n = Number(value);
  if (isNaN(n)) return `${value} ${currency || ""}`.trim();
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

function truncate(s, n) {
  s = s.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function decodeEntities(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function text(msg, status) {
  return new Response(msg, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
