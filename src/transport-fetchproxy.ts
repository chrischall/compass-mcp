// Adapter that lets @fetchproxy/server's FetchproxyServer satisfy
// compass-mcp's CompassTransport interface.
//
// As of @fetchproxy/server 0.8.0, lazy-revive on Chrome MV3
// service-worker eviction (default 2000ms) and per-request timeouts
// (default 30000ms) are server defaults — we get them with zero
// configuration. The convenience `request()` method throws typed
// `FetchproxyBridgeDownError` / `FetchproxyTimeoutError` on failure
// (both subclasses of `FetchproxyProtocolError`). Freshness counters
// previously hand-rolled here now come from `inner.bridgeHealth()`.
//
// 0.9.0: `fetchTimeoutMs` (30_000) and `bridgeReviveDelayMs` (2_000)
// are server defaults — we only forward them when the caller overrides.
// The *resolved* values come back through `inner.bridgeHealth()`, so we
// no longer track a local mirror of `fetchTimeoutMs` here — `status()`
// reads it straight off the health snapshot (fetchproxy#82).
//
// 0.10.0: `keepAliveIntervalMs` is now 25_000 by default (fetchproxy#71)
// — exactly what we used to hardcode — so we drop the explicit option.

import {
  FetchproxyServer,
  type FetchproxyServerOpts,
} from '@chrischall/mcp-utils/fetchproxy';
import type {
  BridgeStatus,
  FetchInit,
  FetchResult,
  RequestJsonResult,
  CompassTransport,
} from './transport.js';

// Re-export the typed errors so downstream tools (healthcheck) keep
// importing them from this module.
export {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
} from '@chrischall/mcp-utils/fetchproxy';

const DEFAULT_PORT = 37_149;

export interface FetchproxyTransportOptions {
  port?: number;
  /** MCP server name announced to the extension. Defaults to 'compass-mcp'. */
  server?: string;
  /** MCP server version. Should match package.json + the banner in index.ts. */
  version: string;
  /** Per-request timeout in ms. Default 30s. Passed through to the server. */
  fetchTimeoutMs?: number;
  /**
   * Delay (ms) before the server's one-shot lazy-revive retry on
   * Chrome MV3 SW-eviction. Default 2000ms. Passed through to the
   * server. Set to 0 to disable.
   */
  bridgeReviveDelayMs?: number;
}

export class FetchproxyTransport implements CompassTransport {
  private readonly inner: FetchproxyServer;
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
      // keepAliveIntervalMs (fetchproxy#71 — keep SW resident across
      // human-paced session gaps) defaults to 25_000 as of 0.10.0, so we
      // no longer pass it explicitly: the 0.10.0 default is exactly the
      // value compass was hardcoding, making this behavior-preserving.
      // fetchTimeoutMs / bridgeReviveDelayMs default to 30_000 / 2_000,
      // matching what we'd otherwise hardcode — only forward when the
      // caller overrides.
      ...(opts.fetchTimeoutMs !== undefined
        ? { fetchTimeoutMs: opts.fetchTimeoutMs }
        : {}),
      ...(opts.bridgeReviveDelayMs !== undefined
        ? { bridgeReviveDelayMs: opts.bridgeReviveDelayMs }
        : {}),
    };
    this.inner = new FetchproxyServer(options);
  }

  async start(): Promise<void> {
    await this.inner.listen();
    // Stderr-only — stdio MCP transports reserve stdout for JSON-RPC.
    console.error(
      `[compass-mcp:bridge] listening on 127.0.0.1:${this.port} ` +
        `(role=${this.inner.role ?? 'unknown'}, version=${this.serverVersion})`
    );
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  /**
   * Diagnostic snapshot of the bridge. Wraps `inner.bridgeHealth()`
   * with this adapter's server-version. `fetchTimeoutMs` is sourced
   * directly from the health snapshot — the server is the source of
   * truth for the resolved timer value (fetchproxy#82).
   */
  status(): BridgeStatus {
    const h = this.inner.bridgeHealth();
    return {
      role: h.role,
      port: this.port,
      serverVersion: this.serverVersion,
      fetchTimeoutMs: h.fetchTimeoutMs,
      lastSuccessAt: h.lastSuccessAt,
      lastFailureAt: h.lastFailureAt,
      lastFailureReason: h.lastFailureReason,
      consecutiveFailures: h.consecutiveFailures,
      lastExtensionMessageAt: h.lastExtensionMessageAt,
    };
  }

  async fetch(init: FetchInit): Promise<FetchResult> {
    // 0.8.0+: `request()` throws FetchproxyBridgeDownError /
    // FetchproxyTimeoutError on bridge failures (both subclass
    // FetchproxyProtocolError). `subdomain` applies only to relative
    // paths; absolute paths self-describe their host, so it's safe to
    // always pass `subdomain: 'www'` even when init.path points at
    // e.g. https://photos.compass.com/x — the server derives tabUrl
    // from the URL host in that case.
    const response = await this.inner.request(init.method, init.path, {
      subdomain: 'www',
      headers: init.headers,
      body: init.body,
    });
    return { status: response.status, body: response.body, url: response.url };
  }

  async requestJson<T>(
    path: string,
    init: {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
      headers?: Record<string, string>;
      body?: unknown;
    } = {}
  ): Promise<RequestJsonResult<T>> {
    // 0.10.0+: `inner.requestJson()` owns serialization, header-defaults
    // (Accept: application/json; Content-Type for non-GET-with-body),
    // 204 → null handling, and JSON.parse. It returns BOTH the parsed
    // `data` and the raw `result` (any HTTP status) and throws the same
    // typed bridge errors as `request()` on transport failure — so the
    // client's per-site `throwIfNotOk` / `throwIfSignInPage` guards stay
    // exactly where they were, just running over `result`. `subdomain`
    // applies only to relative paths; absolute paths self-describe their
    // host, so always passing `subdomain: 'www'` is safe (see fetch()).
    const { data, result } = await this.inner.requestJson<T>(
      init.method ?? 'POST',
      path,
      {
        subdomain: 'www',
        headers: init.headers,
        body: init.body,
      }
    );
    return {
      data,
      result: { status: result.status, body: result.body, url: result.url },
    };
  }
}
