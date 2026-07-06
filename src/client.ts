// CompassClient is the thin, tool-facing API over a CompassTransport.
//
// Compass is a fully SSR React app — there's no public JSON data-API
// surface exposed to the browser, and most of the data we need lives
// inside two inline-script globals on each rendered page:
//
//   - `window.uc.sharedReactAppProps.initialResults` (search results)
//   - `window.__INITIAL_DATA__.props.listingRelation.listing` (homedetails)
//
// So the client surface is small: `fetchHtml` for those SSR pages, plus
// `fetchJson` — which IS in active use for the one structured endpoint
// Compass does expose to the browser, the omnisuggest address
// autocomplete (`/api/v3/omnisuggest/autocomplete`) that powers the
// by-address resolver (issues #78/#79). (sha-only resolution does NOT use
// this endpoint — a bare sha maps straight to `/listing/<sha>/view`,
// fetched via `fetchHtml`, which follows the 302 to homedetails.) Both
// ride through fetchproxy so the user's signed-in compass.com session
// does the actual HTTP.
//
// Error mapping (non-2xx, sign-in interstitial, empty 204 body) lives
// here so tool authors never have to think about it.
import {
  SessionNotAuthenticatedError,
  truncateErrorMessage,
} from '@chrischall/mcp-utils';
import type {
  BridgeStatus,
  BridgeProbeResult,
  FetchResult,
  CompassTransport,
} from './transport.js';

// The canonical parameterized SessionNotAuthenticatedError lives in
// @chrischall/mcp-utils; re-exported so existing `./client.js`
// importers keep working. Thrown below as
// `new SessionNotAuthenticatedError('Compass', 'compass.com')` — the
// message names Compass + the sign-in host and the instance carries a
// machine-readable `hint`.
export { SessionNotAuthenticatedError };

export interface CompassClientOptions {
  /** Transport used to relay fetches to the user's browser. */
  transport: CompassTransport;
}

export class CompassClient {
  // The ONE transport this client rides. Logical multi-session tracking
  // (#41/#42) lives in the fleet-shared SessionRegistry from
  // `@chrischall/mcp-utils/session` (constructed in index.ts, surfaced by
  // the `compass_*_session` tools) — it's a labelled-context layer, not a
  // transport multiplexer: the physical fetchproxy bridge routes to
  // whichever browser tab the extension is bound to right now, same as
  // the zillow/redfin/homes siblings.
  private readonly transport: CompassTransport;

  constructor(opts: CompassClientOptions) {
    this.transport = opts.transport;
  }

  async start(): Promise<void> {
    await this.transport.start();
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  /** Diagnostic snapshot of the bridge — surfaced by `compass_healthcheck`. */
  bridgeStatus(): BridgeStatus {
    return this.transport.status();
  }

  /**
   * Run one healthcheck probe through the active bridge. Delegates to the
   * transport's `runProbe` (the @fetchproxy/server probe loop + classification
   * + post-probe bridge projection). `compass_healthcheck` drives this via
   * `registerBridgeHealthcheckTool`.
   */
  runProbe(
    fetchFn: (path: string) => Promise<unknown>,
    probePath: string
  ): Promise<BridgeProbeResult> {
    return this.transport.runProbe(fetchFn, probePath);
  }

  /**
   * GET a compass.com path, return the HTML body. Throws on non-2xx or
   * sign-in interstitial. The primary primitive for compass-mcp tools —
   * every Compass page server-renders its data into inline scripts that
   * the tool layer parses.
   */
  async fetchHtml(path: string): Promise<string> {
    const result = await this.transport.fetch({ path, method: 'GET' });
    this.throwIfNotOk(result, 'GET', path);
    this.throwIfSignInPage(result);
    return result.body;
  }

  /**
   * POST/PUT/DELETE a JSON body, return the parsed JSON. Throws on
   * non-2xx, invalid JSON, or sign-in page. This is the PRIMARY resolver
   * path for the address resolver (`compass_get_by_address` /
   * `compass_resolve_addresses`), which POSTs to the WAF-immune omnisuggest
   * autocomplete endpoint through here (issues #78/#79). (sha resolution
   * does NOT come through here — `resolvePathFromSha` maps a bare sha to
   * `/listing/<sha>/view` and fetches it via `fetchHtml`.) Also kept ready
   * for any future Compass JSON API (saved-listings or similar).
   *
   * The serialization / header-defaults / 204-handling / JSON.parse all
   * live in `transport.requestJson()` (fetchproxy 0.10.0's `requestJson`
   * envelope, which several MCPs hand-rolled char-for-char). It returns
   * BOTH the parsed `data` and the raw `result`; we keep compass's own
   * `throwIfNotOk` / `throwIfSignInPage` guards over `result` since the
   * sign-in interstitial (AWS WAF challenge) is compass-specific. The
   * one extra wrinkle: `requestJson` succeeds (returns) on any HTTP
   * status, so we run `throwIfNotOk` BEFORE trusting `data` — a parsed
   * body from a 500 must not slip through.
   */
  async fetchJson<T>(
    path: string,
    init: {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
      headers?: Record<string, string>;
      body?: unknown;
    } = {}
  ): Promise<T> {
    const method = init.method ?? 'POST';
    const { data, result } = await this.transport.requestJson<T>(path, {
      method,
      headers: init.headers,
      body: init.body,
    });
    this.throwIfNotOk(result, method, path);
    this.throwIfSignInPage(result);
    return data as T;
  }

  private throwIfNotOk(result: FetchResult, method: string, path: string): void {
    if (result.status >= 200 && result.status < 300) return;
    // truncateErrorMessage (mcp-utils) redacts any bearer/JWT secrets BEFORE
    // truncating at the fleet-wide 500-char budget; we collapse internal
    // whitespace first so multi-line HTML error pages stay one line. Same
    // shape as the opentable/musescore siblings.
    const collapsed = result.body
      ? result.body.replace(/\s+/g, ' ').trim()
      : '';
    const bodyPreview = collapsed ? ` — ${truncateErrorMessage(collapsed)}` : '';
    throw new Error(
      `Compass API error: ${result.status} for ${method} ${path}${bodyPreview}`
    );
  }

  private throwIfSignInPage(result: FetchResult): void {
    // Compass signals a missing session via:
    //   1. Redirect to /login (URL match).
    //   2. AWS WAF challenge interstitial. Marker: the AWS WAF
    //      `awswaf.com/...challenge.js` script is referenced inline.
    //
    // We deliberately do NOT body-match `/login` since every signed-in
    // Compass page has a "Sign in / Log in" link in its nav.
    const looksLikeSignIn =
      /\/login(\?|$)/.test(result.url) ||
      (result.body.includes('awswaf.com') &&
        result.body.includes('challenge.js') &&
        result.body.length < 80_000);
    if (looksLikeSignIn)
      throw new SessionNotAuthenticatedError('Compass', 'compass.com');
  }
}
