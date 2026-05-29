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

/** Diagnostic snapshot returned by `CompassTransport.status()`. */
export interface BridgeStatus {
  /** Role the underlying server elected (host vs peer). `null` until `start()` resolves. */
  role: 'host' | 'peer' | null;
  /** The WebSocket port. Hosts bind it; peers tunnel through it. */
  port: number;
  /** MCP server version announced to the extension. */
  serverVersion: string;
  /** Default per-request timeout in ms. */
  fetchTimeoutMs: number;
  /** Unix-ms timestamp of the last successful round-trip. `null` until the first success. */
  lastSuccessAt: number | null;
  /** Unix-ms timestamp of the last failed round-trip. `null` until the first failure. */
  lastFailureAt: number | null;
  /** Short message describing the most recent failure. `null` until the first failure. */
  lastFailureReason: string | null;
  /** Number of failures since the last success (or since process start, if none). */
  consecutiveFailures: number;
  /** Unix-ms of the most recent inner frame from the extension (0.8.0+). `null` until first frame. */
  lastExtensionMessageAt: number | null;
}

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

  /** Diagnostic snapshot of the bridge. Safe to call any time. */
  status(): BridgeStatus;
}
