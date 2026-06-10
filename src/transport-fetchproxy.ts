// Adapter that lets @fetchproxy/server's FetchproxyServer satisfy
// compass-mcp's CompassTransport interface.
//
// As of @chrischall/mcp-utils 0.9, the FetchproxyServer construction +
// start/close lifecycle AND the per-verb passthroughs (fetch / requestJson /
// runProbe) that ~12 fetchproxy MCPs each hand-rolled are factored into
// `createFetchproxyTransport`. 0.10.0 additionally folds in the canonical
// `[compass-mcp:bridge] listening …` startup banner (`logListening: true`) and
// the `serverVersion` field on `status()` — both of which compass used to
// hand-roll — so this class no longer carries either. We delegate to the inner
// adapter and keep only what's compass-specific: the port/serverName/domain
// pins and the `defaultSubdomain: 'www'` choice (every relative compass path is
// served from www.compass.com). The verb adapters forward `FetchproxyServerOpts`
// verbatim, so the compass contract is intact — port 37149, fetchTimeoutMs /
// revive defaults from the server (0.10.0: keepAliveIntervalMs default 25_000
// too), and the typed FetchproxyBridgeDownError / FetchproxyTimeoutError thrown
// straight through on bridge failure.

import {
  createFetchproxyTransport,
  type FetchproxyTransport as FetchproxyTransportAdapter,
} from '@chrischall/mcp-utils/fetchproxy';
import type {
  BridgeStatus,
  BridgeProbeResult,
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
  // createFetchproxyTransport owns the FetchproxyServer construction, the
  // start/close lifecycle (incl. the canonical `[compass-mcp:bridge]
  // listening …` banner via `logListening: true`), and the fetch /
  // requestJson / runProbe verb passthroughs (each with `defaultSubdomain:
  // 'www'` applied). We keep this thin class so the CompassTransport interface
  // (consumed by CompassClient and the session tools) stays stable.
  private readonly inner: FetchproxyTransportAdapter;

  constructor(opts: FetchproxyTransportOptions) {
    this.inner = createFetchproxyTransport({
      port: opts.port ?? DEFAULT_PORT,
      serverName: opts.server ?? 'compass-mcp',
      version: opts.version,
      // Subdomains of compass.com (www, photos, etc.) match automatically.
      domains: ['compass.com'],
      // Every relative compass path is served from www.compass.com — the verb
      // adapters apply this unless a per-call subdomain overrides it. Absolute
      // http(s):// paths self-describe their host and ignore it (so a
      // photos.compass.com URL still routes to the photos tab).
      defaultSubdomain: 'www',
      // 0.10.0: emit the canonical fleet startup banner from the factory's
      // start() (stderr only — stdout is the MCP JSON-RPC channel):
      //   [compass-mcp:bridge] listening on 127.0.0.1:<port> (role=…, version=…)
      // Byte-identical to the banner compass used to hand-roll; the factory
      // resolves <port> from bridgeHealth() after listen.
      logListening: true,
      // keepAliveIntervalMs (fetchproxy#71) defaults to 25_000 as of 0.10.0,
      // and fetchTimeoutMs / bridgeReviveDelayMs default to 30_000 / 2_000 —
      // matching what compass would otherwise hardcode. Only forward when the
      // caller overrides.
      ...(opts.fetchTimeoutMs !== undefined
        ? { fetchTimeoutMs: opts.fetchTimeoutMs }
        : {}),
      ...(opts.bridgeReviveDelayMs !== undefined
        ? { bridgeReviveDelayMs: opts.bridgeReviveDelayMs }
        : {}),
    });
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  /**
   * Diagnostic snapshot of the bridge — delegated straight through. As of
   * 0.10.0 the adapter's `status()` additively pins `serverVersion` to the
   * `version` opt (the projection compass used to hand-roll), so this is a
   * plain passthrough that already satisfies `BridgeStatus`.
   */
  status(): BridgeStatus {
    return this.inner.status();
  }

  async fetch(init: FetchInit): Promise<FetchResult> {
    // 0.8.0+: throws FetchproxyBridgeDownError / FetchproxyTimeoutError on
    // bridge failures (both subclass FetchproxyProtocolError). `defaultSubdomain:
    // 'www'` is applied by the adapter; absolute paths self-describe their host.
    return this.inner.fetch(init);
  }

  async requestJson<T>(
    path: string,
    init: {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
      headers?: Record<string, string>;
      body?: unknown;
    } = {}
  ): Promise<RequestJsonResult<T>> {
    // The adapter's requestJson(method, path, init) owns serialization,
    // header-defaults, 204 → null, and JSON.parse — returning BOTH `data` and
    // the raw `result` so the client keeps its per-site throwIfNotOk /
    // throwIfSignInPage guards over `result`. compass's interface takes the
    // method inside `init` (default POST); map that onto the adapter's
    // positional-method signature.
    return this.inner.requestJson<T>(init.method ?? 'POST', path, {
      headers: init.headers,
      body: init.body,
    });
  }

  runProbe(
    fetchFn: (path: string) => Promise<unknown>,
    probePath: string
  ): Promise<BridgeProbeResult> {
    // The probe loop + classification + post-probe bridgeHealth() projection
    // live in @fetchproxy/server's runProbe (the transport half of the
    // healthcheck the cohort hand-rolled). compass_healthcheck consumes this
    // through registerBridgeHealthcheckTool.
    return this.inner.runProbe(fetchFn, probePath);
  }
}
