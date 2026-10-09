# compass-mcp

[![CI](https://github.com/chrischall/compass-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/chrischall/compass-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/compass-mcp)](https://www.npmjs.com/package/compass-mcp)
[![license](https://img.shields.io/npm/l/compass-mcp)](LICENSE)

Compass real-estate access as an MCP server for Claude — search listings, fetch property details, photo galleries, price history, and run affordability/mortgage math, all via natural language.

> ⚠️ Compass does not publish a public consumer API. This server scrapes the same server-rendered HTML compass.com itself ships to your browser, routed through your own signed-in browser tab via the [ContextMint Bridge](https://github.com/nullnet-app/contextmint-bridge) extension. Every request acts on behalf of your existing session — your cookies, your TLS, your JS context — exactly as if you'd clicked it in the browser yourself. Treat this as informal use of Compass's website. Use at your own discretion.

## Tools

| Tool | Purpose | Auth-scoped |
| --- | --- | :---: |
| `compass_search_properties` | Search listings by location, price band, beds, home type. Slugifies free-text into Compass's URL routing and extracts the SSR listings array. | |
| `compass_get_property` | Full record for a property by URL or `listing_id_sha`. Address, neighborhood, beds/baths, sqft, lot, price + $/sqft, monthly charges, MLS status, amenities, schools, parcel number. | |
| `compass_get_property_photos` | Full photo gallery — every image in `listing.media[]` with original + thumbnail URLs and pixel dimensions. Floorplans/other media gated behind `include_all_categories`. | |
| `compass_get_price_history` | Full listing-history events (Listed / Sold / Pending / Price Change / Delisted) with date, price, status, and MLS attribution. Returns both this-listing and prior-listing aggregates. | |
| `compass_compare_properties` | Side-by-side comparison of up to 25 properties with an opt-in aligned summary table. Per-target errors captured per-row. Concurrent fetches. | |
| `compass_calculate_affordability` | Local affordability calculator — max purchase price from income + DTI + rates. No network. | |
| `compass_get_by_address` | Resolve a free-text street address to the canonical Compass URL, `listing_id_sha`, and `pid` in one call. Returns `{ resolved: false, error: "no listing found" }` rather than throwing when there is no match. | |
| `compass_calculate_mortgage` | Local PITI calculator — principal+interest, taxes, insurance, HOA, PMI. No network. | |
| `compass_get_saved_homes` | **Not yet supported** — Compass renders /overview/favorites via auth-scoped GraphQL we have not yet identified. Throws a clear "not yet wire" error. | ✓ |
| `compass_get_saved_searches` | **Not yet supported** — same constraint as saved homes. | ✓ |

## Response size

The listing read tools take an optional `view` argument: `"compact"` (the default) or `"full"`. Compact strips image and avatar URLs (including `primary_photo_url` / `primary_thumbnail_url`) and keeps every other field; `view: "full"` returns the payload with those URLs intact.

Tools that take `view`: `compass_search_properties`, `compass_get_property`, `compass_bulk_get`, `compass_compare_properties`, `compass_get_price_history`, `compass_get_comparable_rentals`, `compass_get_agent_listings`, `compass_get_by_address`.

> **Changed in 1.1.9:** `compass_get_property`, `compass_bulk_get`, `compass_compare_properties`, `compass_get_price_history` and `compass_get_comparable_rentals` used to return every field, media URLs included. They now default to compact like the other read tools. If you relied on photo or avatar URLs from these tools, pass `view: "full"`, or use `compass_get_property_photos` for the gallery.

`compass_get_property_photos` takes no `view` — its gallery URLs are the whole point of the tool, so it always returns them.

## Acknowledgement of Terms

By using this MCP server, you acknowledge and agree to the following:

**1. This server accesses your own Compass session.** Every request is dispatched through your own browser tab via the ContextMint Bridge extension — your cookies, your TLS, your session. It does not — and cannot — access anyone else's account.

**2. [Compass's Terms of Use](https://www.compass.com/about/terms-of-use) govern your use of this server**, just as they govern your direct use of compass.com. The clauses most relevant here:

> You may not automatedly crawl or query the Services for any purpose or by any means (including, without limitation, screen and database scraping, spiders, robots, crawlers and any other automated activity with the purpose of obtaining information from the Services) unless you have received prior express written permission from the applicable Compass Company.

And: *"You agree to keep your password confidential, not use others' accounts, nor permit others to use your account."*

You are agreeing to those terms — read by the maintainer 2026-05-23 — every time you invoke a tool in this server. Compass's terms prohibit automated crawling without written permission, and IDX listing data is licensed for personal, non-commercial use only.

**3. Personal, non-commercial use only.** This project is not affiliated with, endorsed by, sponsored by, or in partnership with Compass, Inc. It is a personal automation tool that reads the same server-rendered HTML compass.com itself ships to your browser. Do not use it to bulk-extract listings, redistribute IDX data, train AI models, populate a competing real-estate product, or for any commercial purpose.

**4. Stability is not guaranteed.** This server reads private inline-script state (`global.uc.sharedReactAppProps`, `window.__INITIAL_DATA__.props.listingRelation.listing`) and SSR URL conventions (`/homes-for-sale/<slug>/`, `/homedetails/<slug>/<id>_lid/`) that Compass may change without notice. It may break. It may stop working. That's by design — the surface is not theirs to maintain on our behalf.

**5. You accept full responsibility** for any consequences of using this server in connection with your Compass access — rate limiting, account suspension, IP blocks, AWS WAF challenges, or any enforcement action Compass takes. If Compass objects to your use, stop using this server.

This section is the maintainer's good-faith summary of the terms — it is not legal advice and does not modify or supersede Compass's actual ToU.

## Install

### Option A — npx (after first publish)

Add to `.mcp.json`:

```json
{
  "mcpServers": {
    "compass": {
      "command": "npx",
      "args": ["-y", "compass-mcp"]
    }
  }
}
```

### Option B — from source

```bash
git clone https://github.com/chrischall/compass-mcp
cd compass-mcp
npm install
npm run build
```

```json
{
  "mcpServers": {
    "compass": {
      "command": "node",
      "args": ["/path/to/compass-mcp/dist/bundle.js"]
    }
  }
}
```

### One-time browser setup

compass-mcp talks to your browser through the **ContextMint Bridge** extension, which is shared across every fetchproxy-based MCP (zillow-mcp, opentable-mcp, resy-mcp, …). Install it once from the [ContextMint Bridge releases](https://github.com/nullnet-app/contextmint-bridge/releases):

- **Chrome:** download the Chrome zip, unzip it, then `chrome://extensions` → toggle Developer mode → Load unpacked → pick the unzipped folder.
- **Safari:** the bridge ships inside the ContextMint app; you enable it in Safari's settings. The ContextMint app has no public download yet, so there is no Safari install link to give — use Chrome for now.

**Where it comes from.** ContextMint Bridge is the fetchproxy browser extension under its new name, from the same maintainer — fetchproxy's own README ([Extension](https://github.com/chrischall/fetchproxy#extension)) points to it. Its source is public at [nullnet-app/contextmint-bridge](https://github.com/nullnet-app/contextmint-bridge): build it yourself (its README covers `npm run build`), or check a release zip against the `.sha256` file published beside it:

```bash
shasum -a 256 -c contextmint-bridge-chrome-<version>.zip.sha256
```

Open compass.com and sign in. That's all the auth this server needs.

## How it works

```
┌────────────────┐  stdio   ┌──────────────────┐   WS   ┌──────────────────┐    fetch()    ┌─────────────┐
│ MCP client     │◀────────▶│  dist/bundle.js  │◀──────▶│  ContextMint     │◀────────────▶│ compass.com  │
│ (Claude, etc.) │          │  (Compass MCP)    │ :37149 │  Bridge          │   (real TLS, │ (your tab)  │
└────────────────┘          └──────────────────┘        │  (separate)      │   cookies)    └─────────────┘
```

The MCP server runs in Node, but every HTTP call to compass.com is dispatched into your live browser tab through the ContextMint Bridge extension. Each request rides your existing session — TLS fingerprint, cookies, and JS execution context all match the page that's already on screen. No headless browser stand-in, no separate identity, no third-party proxy: just your real browser, acting on its own behalf, with the MCP server picking what to ask for.

Compass's pages are SSR React with no public JSON API — every tool extracts data from inline-script globals (`global.uc.sharedReactAppProps` on search pages, `window.__INITIAL_DATA__.props.listingRelation.listing` on homedetails). The client wraps that into the tool surface so callers never have to parse HTML themselves.

## Commands

```bash
npm test               # vitest, mocked transport, no network
npm run test:watch
npm run test:coverage
npm run build          # tsc --noEmit + esbuild bundle → dist/bundle.js
npm run dev            # node dist/bundle.js (after build)
```

## License

MIT
