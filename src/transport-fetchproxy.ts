// Adapter that lets @fetchproxy/server's FetchproxyServer satisfy
// compass-mcp's CompassTransport interface.
//
// FetchproxyServer is domain-agnostic — its FetchInit shape is
// `{ url, method, tabUrl, headers?, body? }`. compass-mcp's tools and
// CompassClient use compass-relative paths (`/homedetails/...`,
// `/async-create-search-page-state/`), so the adapter prepends
// `https://www.compass.com` and pins `tabUrl` to compass.com so the
// extension routes the fetch through the right tab.
import { FetchproxyServer, type FetchproxyServerOpts } from '@fetchproxy/server';
import type { FetchInit, FetchResult, CompassTransport } from './transport.js';

const COMPASS_ORIGIN = 'https://www.compass.com';
const COMPASS_TAB_URL = 'https://www.compass.com/';

/**
 * Per-request timeout in milliseconds. The fetchproxy WebSocket bridge
 * has no built-in timeout — if the extension drops a request mid-flight
 * (service-worker sleep, tab navigation, network blip) the `inner.fetch`
 * promise can hang indefinitely. 30s is generous for a Compass SSR
 * page (largest production responses ~1 MB) without being a silent
 * forever-wait.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export class FetchproxyTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(
      `fetchproxy: ${url} did not respond within ${timeoutMs}ms. ` +
        `Check that compass.com is open in the signed-in tab and the ` +
        `fetchproxy extension shows a green dot. Service-worker sleep ` +
        `or a frozen tab are the usual causes.`
    );
    this.name = 'FetchproxyTimeoutError';
  }
}

export interface FetchproxyTransportOptions {
  port?: number;
  /** MCP server name announced to the extension. Defaults to 'compass-mcp'. */
  server?: string;
  /** MCP server version. Should match package.json + the banner in index.ts. */
  version: string;
  /** Per-request timeout in ms. Default 30s. */
  fetchTimeoutMs?: number;
}

export class FetchproxyTransport implements CompassTransport {
  private readonly inner: FetchproxyServer;
  private readonly fetchTimeoutMs: number;

  constructor(opts: FetchproxyTransportOptions) {
    const options: FetchproxyServerOpts = {
      port: opts.port ?? 37149,
      serverName: opts.server ?? 'compass-mcp',
      version: opts.version,
      // Subdomains of compass.com (www, photos, etc.) match automatically.
      domains: ['compass.com'],
    };
    this.inner = new FetchproxyServer(options);
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  start(): Promise<void> {
    return this.inner.listen();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  async fetch(init: FetchInit): Promise<FetchResult> {
    const url = init.path.startsWith('http')
      ? init.path
      : `${COMPASS_ORIGIN}${init.path}`;
    const inner = this.inner.fetch({
      url,
      method: init.method,
      tabUrl: COMPASS_TAB_URL,
      headers: init.headers,
      body: init.body,
    });
    // Attach a no-op rejection handler up front so a WS drop or other
    // late failure on `inner` — arriving AFTER the race already settled
    // on the timeout side — doesn't become an unhandled rejection that
    // crashes the MCP server in Node ≥15.
    inner.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      inner,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new FetchproxyTimeoutError(url, this.fetchTimeoutMs)),
          this.fetchTimeoutMs
        );
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    // fetchproxy returns a discriminated union. CompassTransport's
    // contract is "return on HTTP-level outcomes (including 4xx/5xx),
    // throw on protocol-level failures". Map ok:false to a thrown error.
    if (!result.ok) {
      throw new Error(`fetchproxy transport error: ${result.error}`);
    }
    return { status: result.status, body: result.body, url: result.url };
  }
}
