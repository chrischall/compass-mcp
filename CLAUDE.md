# CLAUDE.md — compass-mcp

Guidance for Claude working in this repo.

## TL;DR

Compass MCP server. Default and only transport: localhost WebSocket via [`@fetchproxy/server`](https://github.com/chrischall/fetchproxy) — the companion browser extension is installed separately rather than embedded. Every HTTP call to compass.com is dispatched through the user's signed-in Chrome tab — each request rides their existing session (cookies, TLS, JS context) exactly as if they'd clicked it themselves.

This is a "Pattern A" fetchproxy MCP (every call rides through fetchproxy), not "Pattern B" (one bootstrap call then direct fetch). Compass validates each request at the session level, so the in-session routing has to be per-call.

## Tool surface

| Tool | File | Endpoint | Kind |
| --- | --- | --- | --- |
| `compass_search_properties` | `tools/search.ts` | `GET /homes-for-sale/<slug>/<filters>/` SSR — extract `global.uc.sharedReactAppProps.initialResults.lolResults.data[]` | read |
| `compass_get_property` | `tools/properties.ts` | `GET /homedetails/<slug>/<listingIdSHA>_lid/` SSR — extract `window.__INITIAL_DATA__.props.listingRelation.listing` | read |
| `compass_get_property_photos` | `tools/photos.ts` | Same SSR page as `get_property` — `listing.media[]` | read |
| `compass_get_price_history` | `tools/history.ts` | Same SSR page — `listing.events[]` + `listing.history[]` | read |
| `compass_compare_properties` | `tools/compare.ts` | Concurrent `get_property` calls across N targets | read |
| `compass_bulk_get` | `tools/bulk-get.ts` | Concurrent `get_property` calls across up to 200 targets (by `url` or `listing_id_sha`); one row per target, no summary | read |
| `compass_get_comparable_rentals` | `tools/comparable-rentals.ts` | Lift target locality from homedetails, then `GET /homes-for-sale/<slug>/type-rental/` SSR for nearby rentals | read |
| `compass_get_saved_homes` | `tools/saved.ts` | **Not yet supported** — placeholder that throws a clear error | read (auth, todo) |
| `compass_get_saved_searches` | `tools/saved.ts` | **Not yet supported** — placeholder that throws a clear error | read (auth, todo) |
| `compass_calculate_mortgage` | `tools/mortgage.ts` | (local; no network) — delegates to realty-core `calculateMortgage` | read |
| `compass_calculate_affordability` | `tools/affordability.ts` | (local; no network) — delegates to realty-core `calculateAffordability` | read |
| `compass_get_by_address` | `tools/by-address.ts` | `POST /api/v3/omnisuggest/autocomplete` (WAF-immune typeahead, primary) → SSR `/homes-for-sale/?q=` / `<slug>/` fallbacks; verifies each candidate | read |
| `compass_resolve_addresses` | `tools/resolve-addresses.ts` | Bulk `get_by_address` — concurrent server-side resolution of many addresses, one round trip, shared rung walker + per-row error contract | read |
| `compass_get_agent_listings` | `tools/agent-listings.ts` | `GET /agents/<slug>/` SSR — extract `window.__AGENT_PROFILE__.data.agentProfileProps.activeListingsProps.initialSales[]` (+ `closedDealsProps.initialSales[].listing` when `include_closed`) | read |
| `compass_healthcheck` | `tools/healthcheck.ts` | Round-trips a no-op `GET /robots.txt` through the bridge to confirm bridge + extension + tab are responsive | read |
| `compass_get_session_context` | `tools/session.ts` | (local; shared session registry) — list all registered logical sessions + `active_session_id` | read |
| `compass_register_session` | `tools/session.ts` | (local; shared session registry) — register/refresh a session keyed by `account_identity` (required); optional `auth_expires_at`; `mark_active` (default false) registers-and-activates | write (registry) |
| `compass_set_active_session` | `tools/session.ts` | (local; shared session registry) — switch the active logical session by `session_id` | write (registry) |

## Architecture

```
src/
  index.ts              # entry — builds FetchproxyTransport, CompassClient,
                        #   registers tool groups, connects stdio transport
  transport.ts          # CompassTransport interface (BridgeStatus = @fetchproxy/server's BridgeHealth)
  transport-fetchproxy.ts # thin delegate over mcp-utils' createFetchproxyTransport
                        #   (FetchproxyServer construction + start/close + fetch/requestJson/runProbe verbs)
  client.ts             # CompassClient.fetchHtml / fetchJson
                        #   + sign-in detection (WAF challenge / /login redirect)
  page-state.ts         # extractUc + extractInitialData + extractAgentProfile + balanced-brace helpers
  url.ts                # extractPidFromUrl + extractAgentSlug + agentProfilePath
                        #   (urlToPath + locationToSlug re-exported from realty-core)
  features.ts           # loadCommunities (local FS read of COMPASS_COMMUNITIES_FILE)
                        #   + re-exports extractFeatures/ExtractedFeatures from realty-core
                        #   (used by tools/properties.ts to keyword-parse listing prose)
  mcp.ts                # textResult() result-wrapper
  tools/
    search.ts           # compass_search_properties (buildSearchPath + formatHome)
    properties.ts       # compass_get_property (fetchListingRecord + format + resolvePathFromSha)
    photos.ts           # compass_get_property_photos (listing.media[])
    history.ts          # compass_get_price_history (events + history)
    compare.ts          # compass_compare_properties (concurrent get_property, ≤25)
    bulk-get.ts         # compass_bulk_get (concurrent get_property, ≤200, no summary)
    comparable-rentals.ts # compass_get_comparable_rentals (locality → rentals search)
    saved.ts            # compass_get_saved_homes + compass_get_saved_searches (stubs)
    mortgage.ts         # compass_calculate_mortgage (realty-core calculateMortgage + adapter)
    affordability.ts    # compass_calculate_affordability (realty-core calculateAffordability)
    by-address.ts       # compass_get_by_address (address → canonical URL + ids; typeahead rung)
    resolve-addresses.ts # compass_resolve_addresses (bulk by-address, shared rung walker)
    typeahead.ts        # omnisuggest autocomplete helpers (WAF-immune resolution rung)
    agent-listings.ts   # compass_get_agent_listings (/agents/<slug>/ __AGENT_PROFILE__ → active + closed listings)
    healthcheck.ts      # compass_healthcheck — thin wiring of mcp-utils'
                        #   registerBridgeHealthcheckTool (probe loop + hint ladder + result shape live there)
    session.ts          # compass_get_session_context / register_session /
                        #   set_active_session — thin wrapper over the shared
                        #   registerSessionTools from @chrischall/mcp-utils/session
                        #   (registry built via createSessionRegistry in index.ts;
                        #   bridge health lives in compass_healthcheck, not in
                        #   session rows)

tests/                  # mirrors src/ (incl. tests/tools/*), plus tests/helpers.ts harness,
                        #   features.test.ts, and version-sync.test.ts (asserts every
                        #   `// x-release-please-version` line matches package.json).
                        #   Tool tests mock CompassClient.fetchHtml.
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
COMPASS_WS_PORT=37149            # override the fetchproxy WebSocket port
COMPASS_COMMUNITIES_FILE=<path>  # JSON string-array of community names for
                                 # feature extraction; overrides the built-in
                                 # Lake Lure / mountain-NC default vocabulary
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

- **No public JSON data-API; SSR inline scripts instead.** Unlike Redfin, Compass doesn't expose listing/search data through `/api/...` endpoints — those tools extract state from each SSR page's inline scripts. The one structured endpoint Compass does serve to the browser is the omnisuggest address autocomplete (`POST /api/v3/omnisuggest/autocomplete`), which is WAF-immune and powers the by-address resolver (`tools/typeahead.ts`, issues #78/#79) — the only place `client.fetchJson` is used. (sha-only lookups don't touch it: a bare sha maps to `/listing/<sha>/view`, which 302-redirects to the slugged homedetails page — omnisuggest is an ADDRESS typeahead and returns nothing for a sha.)
- **Two state globals.** Search pages set `global.uc = {...}` with results at `uc.sharedReactAppProps.initialResults.lolResults.data[]`. Homedetails pages set `window.__INITIAL_DATA__ = {...}` with the listing at `props.listingRelation.listing`. `src/page-state.ts` extracts both via balanced-brace parsing.
- **listing.media[] for photos.** Each photo carries `originalUrl` (full-res) and `thumbnailUrl` (~640×480), plus `width`/`height` and a `category` (0 = photo, non-zero = floorplan/other).
- **events vs. history.** `events[]` is this listing's MLS events; `history[]` aggregates events from prior listings of the same property. We surface both — `get_price_history` returns parallel arrays + counts.
- **No public saved-listings endpoint.** `/overview/favorites` is fully client-rendered via auth-scoped GraphQL. The current surface stubs the tools out with a clear "not yet supported" error and a link to the tracking issue. A future Pattern-B bootstrap (intercept the GraphQL response from the live tab) could unlock this.
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

<!-- pr-workflow:v2 -->
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

The **PR title MUST be a Conventional Commit**, written user-facing (`fix(scope): …`, `feat(scope): …`), not internal shorthand. Because the repo squash-merges, the PR title *becomes the squash commit's subject line* — the only thing release-please parses to pick the version bump and changelog section. Only `feat` (minor), `fix` (patch), and `!`/`BREAKING CHANGE` (major) cut a release; `perf`/`refactor`/`docs` show in the changelog without bumping; `ci`/`test`/`build`/`chore` are recognised but hidden (see `release-please-config.json` → `changelog-sections`). A title without a conventional type is invisible to release-please — no bump, no changelog line. Prefixes in *individual commits* don't help; squash keeps only the title.

**Exception for first-party dependency bumps.** When bumping a package we own (currently `@fetchproxy/server` — anything published from a chrischall-owned repo), label the PR `enhancement` or `bug` instead of `dependencies`, and use the matching commit prefix (`feat:` or `fix:`) instead of `chore:`. Those bumps deliver real product fixes or features through us, so they should drive a release-please version bump and show up under Features/Bug Fixes in the release notes — not get hidden under "Dependencies" (which doesn't trigger a release).

### How PRs merge

**Don't run `gh pr merge` yourself.** The automation does it:

1. `pr-auto-review.yml` runs a Claude review on every PR **except** the release-please release PR (which it deliberately skips). A `pass` **or** `warn` verdict adds the `ready-to-merge` label; `warn`/`fail` also open or update an `auto-review-followup` issue capturing the findings, and only `fail` blocks the merge.
2. `auto-merge.yml`, on the `ready-to-merge` label (or on a dependabot PR), arms `gh pr merge --auto --squash`. The moment CI is green the PR squash-merges itself.

For ordinary feature/fix PRs, opening with `gh pr create --label <label>` (or `--label ignore-for-release` for chores not worth a release-notes line) is the whole job. If Claude's verdict was `warn`/`fail` but you've decided to ship anyway, add the label yourself: `gh pr edit <num> --add-label ready-to-merge`.

### Auto-review follow-up issues

When a PR's auto-review verdict is `warn` or `fail`, the `chrischall/workflows` pipeline opens or updates a single `auto-review-followup` issue ("Auto-review follow-ups for PR #N") whose checklist captures every finding, and links it from the PR's `<!-- auto-review-verdict -->` comment (`📋 Tracking follow-ups: #N`). `warn` (nits only) still auto-merges — the issue carries the nits forward, so most nits are fixed in a *later* PR; `fail` blocks until the important findings are addressed on the PR itself.

When asked to address the auto-review comments / review findings on a PR:

1. Read the verdict comment, open the linked `auto-review-followup` issue, and treat its checklist as the work list (alongside any inline review comments).
2. Resolve each item, checking off only what you've **verified** is genuinely fixed.
3. If every item is resolved on the current PR, add `Closes #<issue>` to that PR's body so the merge closes it; if some are deferred, check off only the resolved ones and leave the issue open.
4. For nits whose `warn` PR already auto-merged, address them in a follow-up PR that references `Closes #<issue>`.

(Mirrors the fleet-wide convention in `~/.claude/CLAUDE.md`.)

### PR timing — only open when the feature is done

Because PRs auto-merge as soon as auto-review passes, **do not open a PR until the feature is genuinely complete**. There's no draft-PR safety net here:

- Don't open a PR to "stage" work while live verification, follow-up fixes, or final passes are still pending — by the time you finish those, the half-baked PR may already be in `main`.
- Push commits to the branch first; only run `gh pr create` once tests pass, live verification (if applicable) is green, and you'd be comfortable with the change shipping as-is.
- If follow-ups land after a PR is already open, they need to land on the same branch *before* auto-review flips to `pass`. Once the PR squash-merges, late commits orphan onto a stale branch and become their own follow-up PR.
- If you genuinely need a checkpoint review without shipping, open the PR as a GitHub draft (`gh pr create --draft …`) — auto-review skips drafts. Mark it ready-for-review only when the feature is truly done.

**Release PRs are the one manual touch.** release-please opens its own release PR and leaves it open as your staging artifact — `pr-auto-review.yml` skips it on purpose, so it sits there accumulating changes until you decide to ship. When you're ready, add `ready-to-merge` to it the same way: `gh pr edit <num> --add-label ready-to-merge`. The `auto-merge.yml` arm then takes over and the publish job fires the moment the release PR lands.

The repo allows squash-merge only — `--merge` and `--rebase` are blocked at the branch-protection ruleset level.

## What to not do

- Don't add IP-rotation or TLS-impersonation libraries. The whole design is "every request rides the user's own browser session via fetchproxy." Adding cycletls / curl-impersonate / Playwright would replace that with a separate stand-in identity — which both defeats the design and adds engineering surface.
- Don't paste cookies or env-configure auth. Auth lives in the browser.
- Don't register tools that can't be tested against a mock `CompassClient`. All tool logic should be behind `fetchHtml` so tests can drive it without a real WS.
- Don't bump versions speculatively. release-please owns that.
