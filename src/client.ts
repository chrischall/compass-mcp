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
  FetchResult,
  CompassTransport,
} from './transport.js';

/**
 * Public-facing summary of a registered Compass session. Returned from
 * `client.listSessions()` and surfaced by `compass_get_session_context`.
 *
 * Today the single-session case (one signed-in compass.com tab via the
 * fetchproxy bridge) is the only one we support — `sessions[]` will
 * have a single entry whose `sessionId` matches `activeSessionId`. The
 * shape is forward-compatible for multi-session support (#41): each
 * registered transport gets its own row + a session_id, and one is
 * designated active.
 */
export interface RegisteredSession {
  sessionId: string;
  status: BridgeStatus;
}

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
  // Session registry. Today this is initialized with a single entry —
  // the one transport passed to the constructor. The shape supports
  // multi-session futures (#41) where additional transports get
  // registered under fresh session_ids. The active session always
  // answers every request unless a per-call routing hint matches
  // another session (not implemented yet — Compass's auth lives in
  // the browser tab, not in a token we can route on).
  private readonly sessions = new Map<string, CompassTransport>();
  private activeSessionId: string;
  private nextSessionSeq = 1;

  constructor(opts: CompassClientOptions) {
    this.activeSessionId = this.allocateSessionId();
    this.sessions.set(this.activeSessionId, opts.transport);
  }

  private allocateSessionId(): string {
    const id = `session-${this.nextSessionSeq}`;
    this.nextSessionSeq += 1;
    return id;
  }

  private get transport(): CompassTransport {
    // Should never miss — `activeSessionId` is always one of the keys
    // by construction.
    const t = this.sessions.get(this.activeSessionId);
    if (!t) {
      throw new Error(
        `CompassClient: active session "${this.activeSessionId}" is not in the registry. This is a bug.`
      );
    }
    return t;
  }

  /**
   * Register an additional transport under a freshly-allocated
   * `session_id`. Returns the id. Does NOT change which session is
   * active — call `setActiveSession()` separately if needed.
   */
  registerSession(transport: CompassTransport): string {
    const id = this.allocateSessionId();
    this.sessions.set(id, transport);
    return id;
  }

  /** Make `id` the active session. Throws when `id` isn't registered. */
  setActiveSession(id: string): void {
    if (!this.sessions.has(id)) {
      throw new Error(
        `unknown session: ${id}. Known: ${[...this.sessions.keys()].join(', ')}`
      );
    }
    this.activeSessionId = id;
  }

  /** Currently-active session id. */
  getActiveSessionId(): string {
    return this.activeSessionId;
  }

  /** Snapshot of every registered session with its bridge status. */
  listSessions(): RegisteredSession[] {
    return [...this.sessions.entries()].map(([sessionId, transport]) => ({
      sessionId,
      status: transport.status(),
    }));
  }

  async start(): Promise<void> {
    // Asymmetry intentional: start() only the active transport; registerSession() during run is future scaffolding, close() being symmetric across all sessions is intentional.
    await this.transport.start();
  }

  async close(): Promise<void> {
    // Close every registered transport so multi-session futures don't
    // leak ports.
    await Promise.all([...this.sessions.values()].map((t) => t.close()));
  }

  /** Diagnostic snapshot of the active bridge — surfaced by `compass_healthcheck`. */
  bridgeStatus(): BridgeStatus {
    return this.transport.status();
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
