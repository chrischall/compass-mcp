# CLAUDE.md — compass-mcp

Guidance for Claude working in this repo.

## TL;DR

v0.1.0: Compass MCP server. Default and only transport: localhost WebSocket via [`@fetchproxy/server`](https://github.com/chrischall/fetchproxy) — the companion browser extension is installed separately rather than embedded. Every HTTP call to compass.com is dispatched through the user's signed-in Chrome tab — each request rides their existing session (cookies, TLS, JS context) exactly as if they'd clicked it themselves.

This is a "Pattern A" fetchproxy MCP (every call rides through fetchproxy), not "Pattern B" (one bootstrap call then direct fetch). Compass validates each request at the session level, so the in-session routing has to be per-call.

## Tool surface

| Tool | File | Endpoint | Kind |
| --- | --- | --- | --- |
| `compass_search_properties` | `tools/search.ts` | `GET /homes-for-sale/<slug>/<filters>/` SSR — extract `global.uc.sharedReactAppProps.initialResults.lolResults.data[]` | read |
| `compass_get_property` | `tools/properties.ts` | `GET /homedetails/<slug>/<listingIdSHA>_lid/` SSR — extract `window.__INITIAL_DATA__.props.listingRelation.listing` | read |
| `compass_get_property_photos` | `tools/photos.ts` | Same SSR page as `get_property` — `listing.media[]` | read |
| `compass_get_price_history` | `tools/history.ts` | Same SSR page — `listing.events[]` + `listing.history[]` | read |
| `compass_compare_properties` | `tools/compare.ts` | Concurrent `get_property` calls across N targets | read |
| `compass_get_saved_homes` | `tools/saved.ts` | **Not yet supported in v0.1.0** — placeholder that throws a clear error | read (auth, todo) |
| `compass_get_saved_searches` | `tools/saved.ts` | **Not yet supported in v0.1.0** — placeholder that throws a clear error | read (auth, todo) |
| `compass_calculate_mortgage` | `tools/mortgage.ts` | (local; no network) | read |
| `compass_calculate_affordability` | `tools/affordability.ts` | (local; no network) | read |

## Architecture

```
src/
  index.ts              # entry — builds FetchproxyTransport, CompassClient,
                        #   registers tool groups, connects stdio transport
  transport.ts          # CompassTransport interface
  transport-fetchproxy.ts # adapter over @fetchproxy/server's FetchproxyServer
  client.ts             # CompassClient.fetchHtml / fetchJson
                        #   + sign-in detection (WAF challenge / /login redirect)
  page-state.ts         # extractUc + extractInitialData + balanced-brace helpers
  url.ts                # urlToPath + locationToSlug
  mcp.ts                # textResult() result-wrapper
  tools/
    search.ts           # compass_search_properties (buildSearchPath + formatHome)
    properties.ts       # compass_get_property (fetchListingRecord + format)
    photos.ts           # compass_get_property_photos (listing.media[])
    history.ts          # compass_get_price_history (events + history)
    compare.ts          # compass_compare_properties (concurrent get_property)
    saved.ts            # compass_get_saved_homes + compass_get_saved_searches (v0.1 stubs)
    mortgage.ts         # compass_calculate_mortgage (local PITI)
    affordability.ts    # compass_calculate_affordability (local DTI math)

tests/                  # 1:1 mirror of src/, plus tests/helpers.ts harness.
                        #   All tests mock CompassClient.fetchHtml.
```

Each `tools/*.ts` file exports `registerXxxTools(server, client)` (or `(server)` for the local-only tools); `src/index.ts` calls all of them.

## Commands

```bash
npm run build          # tsc --noEmit + esbuild bundle → dist/bundle.js
npm test               # vitest, mocked transport, no network
npm run test:watch
npm run test:coverage  # v8 coverage, no thresholds
npx tsc --noEmit       # typecheck only
node dist/bundle.js    # launch the MCP server over stdio (also opens WS)
```

## Environment

No env vars required. Auth lives in the user's signed-in compass.com tab via the fetchproxy extension.

Optional:

```
COMPASS_WS_PORT=37149   # override the fetchproxy WebSocket port
```

## Conventions

- All tools prefixed `compass_*`.
- Tool return shape: `textResult(data)` from `src/mcp.ts` → `{ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }`. Don't hand-roll the wrapper.
- Tool annotations: every tool sets `title`, `readOnlyHint: true`, `idempotentHint: true`, and `openWorldHint`. The last is `true` for network-bound tools and `false` for `compass_calculate_mortgage` / `compass_calculate_affordability` (pure local computation).
- Path-only inputs to `CompassClient`: pass `/some/path?with=query`, never a full URL. `FetchproxyTransport` prepends `https://www.compass.com`. When a tool takes a `url` arg from the user, reduce it via `urlToPath` from `src/url.ts`.
- Write a failing test before implementation (TDD).
- ESM + NodeNext: imports use `.js` extensions even for `.ts` source.
- stdio transport: log warnings/banners to **stderr** only — stdout is reserved for JSON-RPC.

## Compass quirks

- **No stingray-style JSON API.** Unlike Redfin, Compass doesn't expose `/api/...` endpoints we can call directly from a signed-in browser. Every tool extracts state from a SSR page's inline scripts.
- **Two state globals.** Search pages set `global.uc = {...}` with results at `uc.sharedReactAppProps.initialResults.lolResults.data[]`. Homedetails pages set `window.__INITIAL_DATA__ = {...}` with the listing at `props.listingRelation.listing`. `src/page-state.ts` extracts both via balanced-brace parsing.
- **listing.media[] for photos.** Each photo carries `originalUrl` (full-res) and `thumbnailUrl` (~640×480), plus `width`/`height` and a `category` (0 = photo, non-zero = floorplan/other).
- **events vs. history.** `events[]` is this listing's MLS events; `history[]` aggregates events from prior listings of the same property. We surface both — `get_price_history` returns parallel arrays + counts.
- **No public saved-listings endpoint.** `/overview/favorites` is fully client-rendered via auth-scoped GraphQL. The v0.1 surface stubs the tools out with a clear "not yet supported" error and a link to the tracking issue. A future Pattern-B bootstrap (intercept the GraphQL response from the live tab) could unlock this.
- **No market-trends endpoint.** Compass doesn't expose region-level market data in the SSR blob the way Redfin's `market-trends` endpoint does. Deferred to a later version pending more probing.
- **Sign-in detection.** `src/client.ts::throwIfSignInPage` flags `/login` URL redirects and the AWS WAF challenge interstitial (body matches both `awswaf.com` AND `challenge.js` AND body < 80 KB).

## Publishing constraints

The MCP Registry's [server.schema.json](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json) caps `server.json`'s `description` at **100 characters**. Values over that fail `mcp-publisher publish` with HTTP 422 (`validation failed: expected length <= 100, location: body.description`). The other description fields (`manifest.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`) have no published length constraint and can stay longer.

Sanity-check before committing a description change:

```bash
jq -r '.description | length' server.json
```

## Versioning

Version appears in SEVEN places — all must match. `release-please-config.json` registers them as `extra-files` and bumps them in one PR per release:

1. `package.json` → `"version"`
2. `package-lock.json` → kept in sync by `npm install --package-lock-only`
3. `src/index.ts` → `VERSION` const (annotated with `// x-release-please-version`) + startup banner
4. `manifest.json` → `"version"`
5. `server.json` → `"version"` and `packages[].version`
6. `.claude-plugin/plugin.json` → `"version"`
7. `.claude-plugin/marketplace.json` → `metadata.version` + `plugins[].version`

### Release flow

Commits land on `main` via PR. release-please (`.github/workflows/release-please.yml`) opens or updates a release PR whenever Conventional-Commit messages (`feat:`, `fix:`, etc.) accumulate. Merging the release PR creates the tag and a GitHub Release; the `publish` job then packs `.mcpb` + `.skill`, publishes to npm with provenance, and pushes to the MCP Registry.

### Important

Do NOT manually bump versions or create tags unless the user explicitly asks. release-please owns versioning.

## Pull requests & release notes

**Default workflow: branch + PR, even for solo work.** Direct pushes to `main` skip review *and* the auto-generated release notes block (configured in `.github/release.yml`).

For every PR, apply exactly one label:

| Label                  | Section in release notes |
|------------------------|--------------------------|
| `enhancement`          | Features                 |
| `bug`                  | Bug Fixes                |
| `security`             | Security                 |
| `refactor`             | Refactor                 |
| `documentation`        | Documentation            |
| `test`                 | Tests                    |
| `dependencies`         | Dependencies             |
| `ci` / `github_actions`| CI & Build               |
| *(none / unmatched)*   | Other Changes            |
| `ignore-for-release`   | Hidden from notes        |

### How PRs merge

**Do not manually merge PRs — including the release-please release PR.** Open with `gh pr create --label <label>` (or `--label ignore-for-release` for chores not worth a release-notes line). That is the whole job. Do **not** run `gh pr merge --auto --squash` yourself.

The automation handles the rest:

1. `pr-auto-review.yml` runs a Claude review on every PR. On a `pass` verdict it adds the `ready-to-merge` label.
2. `release-please.yml` adds the `ready-to-merge` label to its own release PR automatically.
3. `auto-merge.yml`, on the `ready-to-merge` label (or on a dependabot PR), arms `gh pr merge --auto --squash` for you. The moment CI is green the PR squash-merges itself.

If Claude's review verdict was `warn` or `fail` but you've decided to ship anyway, add the label yourself: `gh pr edit <num> --add-label ready-to-merge`. The repo allows squash-merge only — `--merge` and `--rebase` are blocked at the branch-protection ruleset level.

## What to not do

- Don't add IP-rotation or TLS-impersonation libraries. The whole design is "every request rides the user's own browser session via fetchproxy." Adding cycletls / curl-impersonate / Playwright would replace that with a separate stand-in identity — which both defeats the design and adds engineering surface.
- Don't paste cookies or env-configure auth. Auth lives in the browser.
- Don't register tools that can't be tested against a mock `CompassClient`. All tool logic should be behind `fetchHtml` so tests can drive it without a real WS.
- Don't bump versions speculatively. release-please owns that.
