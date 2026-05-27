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

// Re-export the typed errors so downstream tools (healthcheck) keep
// importing them from this module.
export {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
} from '@fetchproxy/server';

const DEFAULT_PORT = 37_149;
// Matches the server default; surfaced through `status()` so
// compass_healthcheck still reports the timer the bridge is using.
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

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
  private readonly fetchTimeoutMs: number;

  constructor(opts: FetchproxyTransportOptions) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.serverVersion = opts.version;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const options: FetchproxyServerOpts = {
      port: this.port,
      serverName: opts.server ?? 'compass-mcp',
      version: opts.version,
      // Subdomains of compass.com (www, photos, etc.) match automatically.
      domains: ['compass.com'],
      fetchTimeoutMs: this.fetchTimeoutMs,
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
   * with this adapter's server-version + configured timeout.
   */
  status(): BridgeStatus {
    const h = this.inner.bridgeHealth();
    return {
      role: h.role,
      port: this.port,
      serverVersion: this.serverVersion,
      fetchTimeoutMs: this.fetchTimeoutMs,
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
}
