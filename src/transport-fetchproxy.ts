// Adapter that lets @fetchproxy/server's FetchproxyServer satisfy
// compass-mcp's CompassTransport interface.
//
// What this layer DOES instrument (boundary visibility):
//   - The `role` (host vs peer) the FetchproxyServer landed in after
//     `listen()`. Logged once to stderr on startup.
//   - Per-request timing around `this.inner.fetch(...)` when
//     COMPASS_DEBUG=1 is set in the env.
//   - The timeout error carries the role, port, elapsed ms, and the
//     failed URL so the user can tell "bridge never came up" apart
//     from "single request stalled in flight."
//
// What this layer CAN'T instrument (lives upstream in
// https://github.com/chrischall/fetchproxy):
//   - Service worker wake-up + message-listener binding
//   - Content-script injection on the active tab
//   - Tab selection (which compass.com tab the SW picked)
//   - The window.fetch() that actually runs in the page
// If you need that level of detail, file an issue / PR upstream — the
// hooks would need to land in the @fetchproxy/server protocol.

import {
  FetchproxyServer,
  type FetchproxyServerOpts,
} from '@fetchproxy/server';
import type {
  BridgeStatus,
  FetchInit,
  FetchResult,
  CompassTransport,
} from './transport.js';

const COMPASS_ORIGIN = 'https://www.compass.com';
const COMPASS_TAB_URL = 'https://www.compass.com/';

// Generous deadline for a Compass SSR response; the bridge has no
// native timeout, so a frozen tab / dropped extension would otherwise
// hang the MCP call indefinitely.
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

const DEFAULT_PORT = 37_149;

const DEBUG = process.env.COMPASS_DEBUG === '1';

function log(...args: unknown[]): void {
  if (DEBUG) console.error('[compass-mcp:bridge]', ...args);
}

/**
 * Thrown when a request didn't get a response within `fetchTimeoutMs`.
 * Carries enough diagnostic context to distinguish:
 *   - bridge never came up (`role` = null, time elapsed ≈ timeout)
 *   - bridge came up but no extension connected yet
 *   - bridge + extension connected, single request stalled
 */
export class FetchproxyTimeoutError extends Error {
  readonly url: string;
  readonly timeoutMs: number;
  readonly elapsedMs: number;
  readonly role: 'host' | 'peer' | null;
  readonly port: number;
  readonly hint: string;

  constructor(args: {
    url: string;
    timeoutMs: number;
    elapsedMs: number;
    role: 'host' | 'peer' | null;
    port: number;
  }) {
    const hint =
      args.role === null
        ? `the bridge never bound role on startup — listen() may have failed before this request fired. Check stderr from compass-mcp's startup banner.`
        : `bridge is role=${args.role} on port ${args.port}, so the WebSocket side is up; the request reached the bridge but no upstream response arrived within ${args.timeoutMs}ms. Most common causes: (a) the fetchproxy browser extension isn't connected to this MCP yet (check the extension popup for a green dot next to "compass-mcp"), (b) the signed-in compass.com tab is sleeping or was navigated away from before the request resolved, (c) the upstream compass.com fetch itself is hanging on a login redirect or behavioral challenge.`;
    super(
      `fetchproxy: ${args.url} did not respond within ${args.timeoutMs}ms ` +
        `(elapsed ${args.elapsedMs}ms; bridge role=${args.role ?? 'null'} port=${args.port}). ` +
        hint
    );
    this.name = 'FetchproxyTimeoutError';
    this.url = args.url;
    this.timeoutMs = args.timeoutMs;
    this.elapsedMs = args.elapsedMs;
    this.role = args.role;
    this.port = args.port;
    this.hint = hint;
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
  private readonly port: number;
  private readonly serverVersion: string;

  constructor(opts: FetchproxyTransportOptions) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.serverVersion = opts.version;
    const options: FetchproxyServerOpts = {
      port: this.port,
      serverName: opts.server ?? 'compass-mcp',
      version: opts.version,
      // Subdomains of compass.com (www, photos, etc.) match automatically.
      domains: ['compass.com'],
    };
    this.inner = new FetchproxyServer(options);
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    log('listen start', { port: this.port, version: this.serverVersion });
    await this.inner.listen();
    // Stderr-only — stdio MCP transports reserve stdout for JSON-RPC.
    console.error(
      `[compass-mcp:bridge] listening on 127.0.0.1:${this.port} ` +
        `(role=${this.inner.role ?? 'unknown'}, version=${this.serverVersion})`
    );
  }

  async close(): Promise<void> {
    log('close');
    return this.inner.close();
  }

  /**
   * Diagnostic snapshot of the bridge. Safe to call before `start()` —
   * `role` will be null until `listen()` resolves.
   */
  status(): BridgeStatus {
    return {
      role: this.inner.role,
      port: this.port,
      serverVersion: this.serverVersion,
      fetchTimeoutMs: this.fetchTimeoutMs,
    };
  }

  async fetch(init: FetchInit): Promise<FetchResult> {
    const url = init.path.startsWith('http')
      ? init.path
      : `${COMPASS_ORIGIN}${init.path}`;
    const start = Date.now();
    log('fetch:start', {
      method: init.method,
      url,
      role: this.inner.role,
      port: this.port,
    });
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
    let result;
    try {
      result = await Promise.race([
        inner,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const elapsed = Date.now() - start;
            log('fetch:timeout', { url, elapsed, role: this.inner.role });
            reject(
              new FetchproxyTimeoutError({
                url,
                timeoutMs: this.fetchTimeoutMs,
                elapsedMs: elapsed,
                role: this.inner.role,
                port: this.port,
              })
            );
          }, this.fetchTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const elapsed = Date.now() - start;
    if (!result.ok) {
      log('fetch:bridge-error', { url, elapsed, error: result.error });
      throw new Error(
        `fetchproxy transport error after ${elapsed}ms (role=${this.inner.role ?? 'null'}): ${result.error}`
      );
    }
    log('fetch:done', {
      url,
      elapsed,
      status: result.status,
      bodyLen: result.body.length,
    });
    return { status: result.status, body: result.body, url: result.url };
  }
}
