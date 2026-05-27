// CompassClient is the thin, tool-facing API over a CompassTransport.
//
// Compass is a fully SSR React app — there's no clean stingray-style
// JSON API surface exposed to the browser, and the data we need lives
// inside two inline-script globals on each rendered page:
//
//   - `window.uc.sharedReactAppProps.initialResults` (search results)
//   - `window.__INITIAL_DATA__.props.listingRelation.listing` (homedetails)
//
// So the client surface is intentionally minimal: `fetchHtml` for SSR
// pages, plus `fetchJson` kept for any direct API endpoints we find
// later. Both ride through fetchproxy so the user's signed-in
// compass.com session does the actual HTTP.
//
// Error mapping (non-2xx, sign-in interstitial, empty 204 body) lives
// here so tool authors never have to think about it.
import type {
  BridgeStatus,
  FetchInit,
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

export class SessionNotAuthenticatedError extends Error {
  constructor() {
    super(
      'Not signed in to Compass. Open compass.com in your browser and sign in, then try again. ' +
        'Saved searches, saved homes, and recent activity require a signed-in session.'
    );
    this.name = 'SessionNotAuthenticatedError';
  }
}

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
   * non-2xx, invalid JSON, or sign-in page. Currently unused — kept for
   * forward compatibility if Compass exposes a usable JSON API for
   * saved-listings or similar.
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
    const serialised: FetchInit = {
      path,
      method,
      headers: {
        Accept: 'application/json',
        ...(method !== 'GET' && init.body !== undefined
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(init.headers ?? {}),
      },
      body:
        method === 'GET' || init.body === undefined
          ? undefined
          : JSON.stringify(init.body),
    };
    const result = await this.transport.fetch(serialised);
    this.throwIfNotOk(result, method, path);
    this.throwIfSignInPage(result);
    if (result.status === 204 || result.body === '') {
      return null as T;
    }
    try {
      return JSON.parse(result.body) as T;
    } catch (e) {
      throw new Error(
        `Compass ${method} ${path} — response was not JSON: ${String(
          (e as Error).message
        )}`
      );
    }
  }

  private throwIfNotOk(result: FetchResult, method: string, path: string): void {
    if (result.status >= 200 && result.status < 300) return;
    const bodyPreview = result.body
      ? ` — ${result.body.slice(0, 500).replace(/\s+/g, ' ').trim()}${
          result.body.length > 500 ? '…' : ''
        }`
      : '';
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
    if (looksLikeSignIn) throw new SessionNotAuthenticatedError();
  }
}
