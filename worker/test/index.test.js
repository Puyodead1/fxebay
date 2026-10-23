import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { extractItemId, normalizeApiItem, renderEmbed, embedFields } from "../src/index.js";

// Real eBay listing pages, trimmed by fetcher/app.py (meta tags + JSON-LD + fxebay:signals).
const fixture = (name) => readFileSync(new URL(`./fixture-${name}.html`, import.meta.url), "utf8");
const realHtml = fixture("item"); // Buy It Now
const pages = { "198718772370": fixture("auction"), "198737515317": fixture("bo") };

const apiItem = {
  title: "Nintendo Game Boy Color - Teal - Tested & Working",
  price: { value: "89.99", currency: "USD" },
  buyingOptions: ["FIXED_PRICE"],
  condition: "Used",
  image: { imageUrl: "https://i.ebayimg.com/images/g/abc/s-l225.jpg" },
  additionalImages: [{ imageUrl: "https://i.ebayimg.com/images/g/def/s-l225.jpg" }],
  seller: { username: "retro_shop", feedbackPercentage: "99.8", feedbackScore: 4521 },
  shippingOptions: [{ shippingCost: { value: "0.00", currency: "USD" } }],
  itemLocation: { city: "Austin", stateOrProvince: "Texas", country: "US" },
  shortDescription: "Fully tested, new <b>screen</b>, cleaned contacts.",
};

let mode;
const calls = [];
beforeEach(() => { calls.length = 0; });

globalThis.fetch = async (u) => {
  u = String(u);
  calls.push(u);
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
  if (u.includes("oauth2/token")) return json({ access_token: "T", expires_in: 7200 });
  if (u.includes("get_item_by_legacy_id")) {
    if (mode === "group") return json({ errors: [{ errorId: 11006 }] }, 400);
    if (mode === "auction") {
      return json({ ...apiItem, buyingOptions: ["AUCTION", "FIXED_PRICE"], currentBidPrice: { value: "41", currency: "USD" }, bidCount: 1, itemEndDate: "2026-10-25T18:00:00.000Z" });
    }
    return json(apiItem);
  }
  if (u.includes("get_items_by_item_group")) {
    return json({ items: [apiItem, { ...apiItem, price: { value: "120", currency: "USD" } }] });
  }
  if (u.startsWith("https://www.ebay.com/itm/")) {
    return mode === "blocked"
      ? new Response("<title>Error Page | eBay</title>", { status: 403 })
      : new Response(realHtml);
  }
  if (u === "https://site.test/") {
    return mode === "blocked" ? new Response("", { status: 503 }) : new Response("<title>fxebay</title>", { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (u.startsWith("https://fetcher.test/item/")) return new Response(pages[u.split("/").pop()] || realHtml);
  if (u.startsWith("https://fetcher.test/short/")) return json({ location: "https://www.ebay.com/itm/555555555555?mkcid=16" });
  if (u.startsWith("https://ebay.us/") && mode === "blocked") return new Response("", { status: 403 });
  if (u.startsWith("https://ebay.us/")) {
    return new Response(null, { status: 301, headers: { location: "https://www.ebay.com/itm/117298301199?mkcid=16" } });
  }
  throw new Error("unexpected fetch " + u);
};

const keys = { EBAY_CLIENT_ID: "id", EBAY_CLIENT_SECRET: "secret" };
const DISCORD = "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)";

async function get(path, { env = keys, ua = DISCORD, m = "api" } = {}) {
  mode = m;
  const res = await worker.fetch(new Request("https://fx.test" + path, { headers: { "user-agent": ua } }), env, {});
  return { res, body: res.status === 200 ? await res.text() : "" };
}

const meta = (body, prop) => body.match(new RegExp(`<meta (?:property|name)="${prop}" content="([^"]*)">`))?.[1];

test("fixed price listing via Browse API", async () => {
  const { res, body } = await get("/itm/117298301199");
  assert.equal(res.status, 200);
  assert.equal(meta(body, "og:title"), "Nintendo Game Boy Color - Teal - Tested &amp; Working");
  assert.equal(meta(body, "og:description"), "Type: Buy It Now\nCondition: Used\nPrice: $89.99\nShipping: Free");
  assert.equal(meta(body, "og:image"), "https://i.ebayimg.com/images/g/abc/s-l1600.jpg");
  assert.equal(meta(body, "twitter:card"), "summary_large_image");
  assert.match(body, /oembed\.json\?[^"]*author=retro_shop/);
});

test("auction with slug URL", async () => {
  const { body } = await get("/itm/Some-Title-Here/117298301199?hash=item1b4", { m: "auction" });
  assert.equal(
    meta(body, "og:description"),
    "Type: Auction + Buy It Now (1 bid, ends Oct 25, 6:00 PM UTC)\nCondition: Used\nCurrent bid: $41.00\nBuy It Now: $89.99\nShipping: Free",
  );
});

test("variation listing shows price range", async () => {
  const { body } = await get("/itm/117298301199", { m: "group" });
  assert.match(meta(body, "og:description"), /\nPrice: \$89\.99 – \$120\.00\nVariations: 2\n/);
});

test("scrape fallback parses a real eBay page", async () => {
  const { body } = await get("/itm/117298301199", { env: {}, m: "scrape" });
  assert.equal(meta(body, "og:title"), "Commercial Service Sed De Saber Construction Edition Leap pad Spanish Leapfrog");
  assert.equal(meta(body, "og:description"), "Type: Buy It Now\nCondition: New\nPrice: $24.99\nShipping: $16.92");
  assert.match(meta(body, "og:image"), /s-l1600\.jpg$/);
  assert.ok(!calls.some((c) => c.includes("api.ebay.com")), "should not call API without keys");
});

const fetcherEnv = { FETCHER_URL: "https://fetcher.test/", FETCHER_TOKEN: "tok" };

test("fetcher is used when there are no API keys", async () => {
  const { body } = await get("/itm/117298301199", { env: fetcherEnv, m: "blocked" });
  assert.match(meta(body, "og:title"), /^Commercial Service Sed De Saber/);
  assert.ok(calls.includes("https://fetcher.test/item/117298301199"));
  assert.ok(!calls.some((c) => c.startsWith("https://www.ebay.com/")), "no direct scrape when fetcher works");
});

test("real auction page via fetcher", async () => {
  const { body } = await get("/itm/198718772370", { env: fetcherEnv });
  assert.match(
    meta(body, "og:description"),
    // "ends" or "ended" depending on today's date
    /^Type: Auction or Best Offer \(0 bids, (ends|ended) Oct 23, 4:40 AM UTC\)\nCondition: Used\nCurrent bid: \$147\.44(\n|$)/,
  );
});

test("real Buy It Now + Best Offer page via fetcher", async () => {
  const { body } = await get("/itm/198737515317", { env: fetcherEnv });
  assert.match(meta(body, "og:description"), /^Type: Buy It Now or Best Offer\nCondition: Used\nPrice: \$64\.99(\n|$)/);
  // the page's JSON-LD title already contains "&amp;"; it must not be double-escaped
  assert.equal(meta(body, "og:title"), "Vintage Nintendo Game Boy Color - Teal (CGB-001) - Tested &amp; Working");
});

test("short link falls back to fetcher when ebay.us blocks the worker", async () => {
  const { body } = await get("/m/AbCdEf12", { env: fetcherEnv, m: "blocked" });
  assert.ok(calls.includes("https://fetcher.test/short/m/AbCdEf12"));
  assert.ok(calls.includes("https://fetcher.test/item/555555555555"));
  assert.match(meta(body, "og:title"), /^Commercial Service/);
});

test("blocked everywhere still returns a minimal embed", async () => {
  const { res, body } = await get("/itm/117298301199", { env: {}, m: "blocked" });
  assert.equal(res.status, 200);
  assert.equal(meta(body, "og:title"), "eBay item 117298301199");
  assert.equal(meta(body, "og:description"), "Couldn't load listing details.");
});

test("ebay.us short link resolves", async () => {
  const { body } = await get("/m/AbCdEf12");
  assert.ok(calls.some((c) => c.includes("legacy_item_id=117298301199")));
  assert.equal(meta(body, "og:url"), "https://ebay.us/m/AbCdEf12");
});

const FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) Gecko/20100101 Firefox/158.0";

test("humans go to the exact original link", async () => {
  const { res } = await get("/itm/Cool-Shoes/117298301199?var=4242&_skw=shoes", { ua: FIREFOX });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "https://www.ebay.com/itm/Cool-Shoes/117298301199?var=4242&_skw=shoes");
  const short = await get("/m/AbCdEf12", { ua: FIREFOX });
  assert.equal(short.res.headers.get("location"), "https://ebay.us/m/AbCdEf12");
  const bare = await get("/117298301199", { ua: FIREFOX });
  assert.equal(bare.res.headers.get("location"), "https://www.ebay.com/itm/117298301199");
  assert.equal(calls.length, 0, "redirects need no lookups");
});

test("embed links back to the original link", async () => {
  // ?embed forces the embed page in a browser; it must not leak into the link
  const { body } = await get("/itm/Cool-Shoes/117298301199?var=4242&embed", { ua: FIREFOX });
  const original = "https://www.ebay.com/itm/Cool-Shoes/117298301199?var=4242";
  assert.equal(meta(body, "og:url"), original);
  assert.ok(body.includes(`<a href="${original}">`));
  assert.ok(body.includes(`url=${encodeURIComponent(original)}`), "oEmbed points at original");
});

test("malformed escapes don't crash", async () => {
  const { res } = await get("/itm/%E0%A4%A/117298301199");
  assert.equal(res.status, 200);
});

test("root shows the converter site, or redirects to it if unavailable", async () => {
  const env = { HOME_URL: "https://site.test/" };
  const ok = await get("/", { env, ua: FIREFOX });
  assert.equal(ok.res.status, 200);
  assert.equal(ok.body, "<title>fxebay</title>");
  const down = await get("/", { env, ua: FIREFOX, m: "blocked" });
  assert.equal(down.res.status, 302);
  assert.equal(down.res.headers.get("location"), "https://site.test/");
});

test("calculated shipping shows the cheapest option; hidden seller score is omitted", async () => {
  const item = normalizeApiItem({
    ...apiItem,
    shippingOptions: [
      { shippingCostType: "CALCULATED", shippingCost: { value: "7.78", currency: "USD" } },
      { shippingCostType: "CALCULATED", shippingCost: { value: "7.10", currency: "USD" } },
    ],
    seller: { username: "hidden_guy", feedbackPercentage: "100.0", feedbackScore: -1 },
  }, "1");
  assert.equal(item.shipping, "from $7.10");
  assert.match(renderEmbed(item, "https://fx.test"), /author=hidden_guy\+%28100\.0%25%29/);
  const flat = normalizeApiItem({ ...apiItem, shippingOptions: [{ shippingCost: { value: "5", currency: "USD" } }, { shippingCost: { value: "5", currency: "USD" } }] }, "1");
  assert.equal(flat.shipping, "$5.00");
});

test("ended auctions say ended", () => {
  const [[, type]] = embedFields({ type: "Auction", auction: true, bids: 2, endsAt: "2020-01-02T03:04:00Z" });
  assert.equal(type, "Auction (2 bids, ended Jan 2, 3:04 AM UTC)");
});

test("API requests send the ship-to location", async () => {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (u, init) => { if (String(u).includes("browse")) seen.push(init?.headers?.["x-ebay-c-enduserctx"]); return orig(u, init); };
  try {
    await get("/itm/117298301199?zz=1", { env: { ...keys, EBAY_SHIP_TO_ZIP: "10001" } });
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(seen[0], "contextualLocation=country%3DUS%2Czip%3D10001");
});

test("BOM-prefixed API secrets still work", async () => {
  const { body } = await get("/itm/117298301199", { env: { EBAY_CLIENT_ID: "﻿id", EBAY_CLIENT_SECRET: "﻿secret " } });
  assert.match(meta(body, "og:title"), /^Nintendo Game Boy/);
});

test("bad path is a 400", async () => {
  const { res } = await get("/hello/world");
  assert.equal(res.status, 400);
});

test("oembed endpoint", async () => {
  const res = await worker.fetch(new Request("https://fx.test/oembed.json?title=T&author=bob&url=https://www.ebay.com/itm/1"), {}, {});
  const j = await res.json();
  assert.equal(j.provider_name, "eBay");
  assert.equal(j.author_name, "Seller: bob");
});

test("extractItemId", () => {
  assert.equal(extractItemId("/itm/123456789012"), "123456789012");
  assert.equal(extractItemId("/itm/x-y/123456789012?a=1"), "123456789012");
  assert.equal(extractItemId("/sch/i.html?item=123456789012"), "123456789012");
  assert.equal(extractItemId("/123456789012"), "123456789012");
  assert.equal(extractItemId("/itm/abc"), null);
});
