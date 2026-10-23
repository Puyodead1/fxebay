# fxebay

Like fxtwitter, but for eBay. Discord shows no embed for eBay links because eBay
blocks Discord's crawler. Swap the domain and you get a proper embed (title, price,
bids, condition, shipping, location, photo), and clicking still takes you to eBay.

```
https://www.ebay.com/itm/117298301199
https://fxebay.<you>.workers.dev/itm/117298301199
```

## Why there are two parts

GitHub Pages only serves static files. Discord's crawler doesn't run JavaScript,
so a static page can't fill in per-item tags, and every link would show the same
generic embed. fxtwitter avoids this with a small server, and so does this project:

| Part | Where | What it does |
|---|---|---|
| `worker/` | Cloudflare Workers (free plan: 100k requests/day) | Gets item data and serves embed tags to bots, redirects people to eBay |
| `docs/` | GitHub Pages | Landing page and a "paste link → copy fixed link" converter |
| `fetcher/` | Your PC (via tunnel) or a container host. Optional | Fetches eBay pages when there's no API key |

## Where the listing data comes from

eBay blocks scrapers by **TLS fingerprint**: curl, Python `requests`, Postman,
Chrome/Firefox impersonation and the Workers runtime itself all get `403 Error Page`.
The worker tries these sources in order:

1. **eBay Browse API**: official, free and the most reliable. It needs approved developer keys.
2. **Fetcher** (`fetcher/`): a small Python service using `curl_cffi` with a Safari
   fingerprint, which eBay accepts. Use it while your API keys are pending, or instead of them.
3. **Direct scrape**: almost always blocked; it's there as a last resort.

If all three fail, Discord still gets a basic "eBay item 123…" embed.

## Local development

```bash
cd worker
npm install
npm test                 # unit tests (mocked eBay, plus a real listing page as a fixture)
npm run dev              # http://127.0.0.1:8787/itm/<id>?embed shows what Discord sees
```

Put secrets for `npm run dev` in `worker/.dev.vars` (gitignored), one `NAME=value` per line:
`EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `FETCHER_URL`, `FETCHER_TOKEN`.

## Setup

### 1a. eBay developer keys (free; approval can take a day or two)
1. Sign up at <https://developer.ebay.com/> and create an application.
2. Under **Application Keys → Production**, copy the **App ID (Client ID)** and the
   **Cert ID (Client Secret)**. Production keys may require you to set up or opt out of
   "Marketplace account deletion notifications". Choose the exemption: *"I do not
   persist eBay data"*.

### 1b. …and/or the fetcher

The fetcher needs a public HTTPS URL that the worker can reach. Start by making a token:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

**On your PC.** This is the proven setup, since your home IP plus the Safari fingerprint works.
Embeds only work while the PC is on.

```bash
cd fetcher
pip install -r requirements.txt
```
```powershell
$env:FETCHER_TOKEN = "<token>"; python app.py
```

Then expose `http://127.0.0.1:8790` with a tunnel that has a **stable** URL:
- **Tailscale Funnel** (free, no domain needed): `tailscale funnel 8790` gives you
  `https://<pc>.<tailnet>.ts.net`
- **Cloudflare named tunnel** (needs a domain on Cloudflare): `cloudflared tunnel …`.
  Quick tunnels (`cloudflared tunnel --url …`) work too, but their URL changes on every restart.

**In the cloud** (Render, Fly.io, Koyeb, …): deploy `fetcher/` with its `Dockerfile` and
set the `FETCHER_TOKEN` env var. It's always on, but eBay may block datacenter IPs whatever
the fingerprint is. That hasn't been tested, so check `/item/<id>` before relying on it.

Then give the worker its URL and token:
```bash
npx wrangler secret put FETCHER_URL     # e.g. https://mypc.tail1234.ts.net
npx wrangler secret put FETCHER_TOKEN
```

### 2. Deploy the worker
Pick one:

**A — from your PC** (needs Node.js):
```bash
cd worker
npx wrangler login
npx wrangler secret put EBAY_CLIENT_ID
npx wrangler secret put EBAY_CLIENT_SECRET
npx wrangler deploy
```

**B — from GitHub Actions** (no Node needed): in the repo, go to *Settings → Secrets and
variables → Actions* and add `CLOUDFLARE_API_TOKEN` (create one in the Cloudflare
dashboard with the *Edit Cloudflare Workers* template), `CLOUDFLARE_ACCOUNT_ID`,
`EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET`. Then run *Deploy worker* from the Actions tab
(or uncomment the `push` trigger in the workflow to deploy on every push). Set `FETCHER_URL` / `FETCHER_TOKEN` with
`wrangler secret put` or in the Cloudflare dashboard (Worker → Settings → Variables).

Either way, you get a URL like `https://fxebay.<you>.workers.dev`. A custom domain
works too (Workers → Settings → Domains); a short one such as `fxebay.xyz` is nicer to type.

### 3. GitHub Pages
1. In `docs/index.html`, set `const WORKER = "https://fxebay.<you>.workers.dev";`
2. In `worker/wrangler.toml`, set `HOME_URL` to your Pages URL.
3. Repo *Settings → Pages → Deploy from a branch → `main` / `/docs`*.

## Supported links
- `/itm/<id>` and `/itm/<title-slug>/<id>` (query strings are ignored)
- `ebay.us/m/<code>` share links → `<worker>/m/<code>`
- `?item=<id>`
- Add `?embed` to any link to view the bot response in a browser.

`EBAY_MARKETPLACE` in `wrangler.toml` controls currency and shipping estimates
(`EBAY_US`, `EBAY_GB`, `EBAY_DE`, `EBAY_AU`, …).

Discord caches embeds per URL for a while, so a link that was already posted won't
refresh straight away.
