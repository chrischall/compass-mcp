// Transport-agnostic interface for the bridge that relays Compass
// fetches through the user's real Chrome session.
//
// The default implementation in src/transport-fetchproxy.ts wraps
// @fetchproxy/server's FetchproxyServer (127.0.0.1:37149 WebSocket).
//
// CompassClient (src/client.ts) accepts any CompassTransport. Error
// mapping (non-2xx, sign-in interstitial, 204 → null) lives on the
// client, not the transport — every implementation only has to round-
// trip the request and return a {status, body, url} triple.

// `BridgeProbeResult` is @fetchproxy/server's typed result of one
// healthcheck probe (run fetch + measure + classify + project
// bridgeHealth() into a snake-cased `bridge` block). Re-exported via the
// mcp-utils /fetchproxy subpath (single import site). `compass_healthcheck`
// consumes it through `registerBridgeHealthcheckTool`.
import type {
  BridgeHealth,
  BridgeProbeResult,
} from '@chrischall/mcp-utils/fetchproxy';
export type { BridgeProbeResult };

export interface FetchInit {
  /** Path-and-query relative to https://www.compass.com, e.g.
   *  `/homedetails/<slug>/<sha>_lid/` or `/homes-for-sale/<slug>/`. */
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  /** Serialized request body. JSON callers stringify before calling.
   *  Omitted for GETs. */
  body?: string;
}

export interface FetchResult {
  status: number;
  /** Response body as a string. Empty string for 204. */
  body: string;
  /** Final URL after redirects. Used for sign-in-page detection. */
  url: string;
}

/**
 * Diagnostic snapshot returned by `CompassTransport.status()`. This IS
 * @fetchproxy/server's `BridgeHealth` (role / port / serverVersion /
 * fetchTimeoutMs / freshness counters / lastExtensionMessageAt, plus the
 * keepAlive + swEviction observability blocks) — the value the
 * `createFetchproxyTransport` adapter returns verbatim. Aliased here so
 * compass's interface + tools have a single name for it without re-declaring
 * the fields (which drifted from the upstream shape when hand-maintained).
 */
export type BridgeStatus = BridgeHealth;

/**
 * Parsed-JSON round-trip returned by `CompassTransport.requestJson()`.
 * `data` is the JSON-parsed body (`null` for 204 / empty body); `result`
 * is the raw `{status, body, url}` triple so the client can run its own
 * non-2xx / sign-in-interstitial guards. Mirrors the
 * `@fetchproxy/server` `requestJson()` envelope — serialization,
 * header-defaults, 204-handling and `JSON.parse` live in the transport;
 * the HTTP-status / auth guards stay on the client (they're compass-
 * specific).
 */
export interface RequestJsonResult<T> {
  data: T | null;
  result: FetchResult;
}

export interface CompassTransport {
  /** Bring the transport up. Idempotent. */
  start(): Promise<void>;

  /** Tear the transport down. Idempotent. */
  close(): Promise<void>;

  /** Round-trip one request through the bridge. Resolves to a result
   *  triple even for non-2xx statuses — the client maps HTTP errors. */
  fetch(init: FetchInit): Promise<FetchResult>;

  /**
   * Round-trip a request and parse the reply as JSON. Sets
   * `Accept: application/json`, adds `Content-Type: application/json` for
   * a non-GET request carrying a body, `JSON.stringify`s the body, and
   * treats 204 / empty body as `data: null`. Returns BOTH the parsed
   * `data` and the raw `result` — the client runs its own non-2xx /
   * sign-in guards over `result`. Bridge-level failures still throw the
   * typed errors, exactly like `fetch()`.
   */
  requestJson<T>(
    path: string,
    init?: {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
      headers?: Record<string, string>;
      body?: unknown;
    }
  ): Promise<RequestJsonResult<T>>;

  /**
   * Run one healthcheck probe through the bridge: execute `fetchFn(probePath)`,
   * measure elapsed ms, classify any thrown bridge error, and project the
   * post-probe `bridgeHealth()` snapshot. The probe loop + classification live
   * in `@fetchproxy/server`'s `runProbe`; `compass_healthcheck` owns only the
   * tool registration + hint ladder (via `registerBridgeHealthcheckTool`).
   */
  runProbe(
    fetchFn: (path: string) => Promise<unknown>,
    probePath: string
  ): Promise<BridgeProbeResult>;

  /** Diagnostic snapshot of the bridge. Safe to call any time. */
  status(): BridgeStatus;
}
