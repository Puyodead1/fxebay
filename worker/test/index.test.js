import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { extractItemId } from "../src/index.js";

// Trimmed copy of a real eBay listing page (meta tags + JSON-LD only).
const realHtml = readFileSync(new URL("./fixture-item.html", import.meta.url), "utf8");

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
  if (u.startsWith("https://fetcher.test/item/")) return new Response(realHtml);
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
  const desc = meta(body, "og:description");
  assert.match(desc, /^💲 \$89\.99\nUsed · Free shipping\n📍 Austin, Texas, US\n\nFully tested, new screen, cleaned contacts\.$/);
  assert.equal(meta(body, "og:image"), "https://i.ebayimg.com/images/g/abc/s-l1600.jpg");
  assert.equal(meta(body, "twitter:card"), "summary_large_image");
  assert.match(body, /oembed\.json\?[^"]*author=retro_shop/);
});

test("auction with slug URL", async () => {
  const { body } = await get("/itm/Some-Title-Here/117298301199?hash=item1b4", { m: "auction" });
  assert.match(meta(body, "og:description"), /💲 \$41\.00 · 🔨 1 bid · Buy It Now \$89\.99/);
  assert.match(meta(body, "og:description"), /⏰ Ends Sun, 25 Oct 2026 18:00 UTC/);
});

test("variation listing shows price range", async () => {
  const { body } = await get("/itm/117298301199", { m: "group" });
  assert.match(meta(body, "og:description"), /\$89\.99 – \$120\.00/);
  assert.match(meta(body, "og:description"), /2 variations/);
});

test("scrape fallback parses a real eBay page", async () => {
  const { body } = await get("/itm/117298301199", { env: {}, m: "scrape" });
  assert.equal(meta(body, "og:title"), "Commercial Service Sed De Saber Construction Edition Leap pad Spanish Leapfrog");
  assert.match(meta(body, "og:description"), /^💲 \$24\.99\nNew · \+\$16\.92 shipping/);
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

test("short link falls back to fetcher when ebay.us blocks the worker", async () => {
  const { body } = await get("/m/AbCdEf12", { env: fetcherEnv, m: "blocked" });
  assert.equal(meta(body, "og:url"), "https://www.ebay.com/itm/555555555555");
});

test("blocked everywhere still returns a minimal embed", async () => {
  const { res, body } = await get("/itm/117298301199", { env: {}, m: "blocked" });
  assert.equal(res.status, 200);
  assert.equal(meta(body, "og:title"), "eBay item 117298301199");
  assert.equal(meta(body, "og:description"), "Couldn't load listing details.");
});

test("ebay.us short link resolves", async () => {
  const { body } = await get("/m/AbCdEf12");
  assert.equal(meta(body, "og:url"), "https://www.ebay.com/itm/117298301199");
});

test("humans are redirected to eBay", async () => {
  const { res } = await get("/itm/117298301199", { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) Gecko/20100101 Firefox/158.0" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "https://www.ebay.com/itm/117298301199");
  assert.equal(calls.length, 0);
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
