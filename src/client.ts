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
import type { FetchInit, FetchResult, CompassTransport } from './transport.js';

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
