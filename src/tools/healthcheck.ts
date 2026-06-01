import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CompassClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  classifyBridgeError,
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
} from '@chrischall/mcp-utils/fetchproxy';

/**
 * Round-trip a no-op request through the full bridge so the user can
 * tell — with ONE tool call, without needing a real search — whether:
 *
 *   - compass-mcp's WebSocket bridge is up (`bridge.role` non-null)
 *   - the fetchproxy browser extension is connected (request reaches
 *     a tab and a response comes back)
 *   - the active compass.com tab is responsive (the fetch resolved
 *     within the timeout)
 *
 * Probe target: `/robots.txt` on compass.com. It's small (~150 bytes),
 * public (no auth needed), and served from Compass's edge — so a
 * failure here cleanly isolates the bridge from compass.com's own
 * auth/SSR pipeline. If `/robots.txt` round-trips OK but the real
 * search still hangs, the problem is downstream of fetchproxy
 * (Compass redirecting on login, behavioral challenge, etc.); if
 * `/robots.txt` fails, the bridge or extension is the issue.
 */

interface HealthcheckResult {
  ok: boolean;
  bridge: {
    role: 'host' | 'peer' | null;
    port: number;
    server_version: string;
    fetch_timeout_ms: number;
    /** Unix-ms timestamp of the last successful round-trip. `null` until the first success. */
    last_success_at: number | null;
    /** Unix-ms timestamp of the last failed round-trip. `null` until the first failure. */
    last_failure_at: number | null;
    /** Most recent failure reason. `null` until the first failure. */
    last_failure_reason: string | null;
    /** Count of failures since the last success (or process start, if none). */
    consecutive_failures: number;
    /**
     * Unix-ms of the most recent inner frame received from the extension
     * (regardless of whether it was a success/failure for the caller).
     * Distinct from `last_success_at` / `last_failure_at`, which track
     * user-visible outcomes — this is "is the extension still answering?"
     * liveness. `null` until the first frame arrives.
     */
    last_extension_message_at: number | null;
  };
  probe: {
    url: string;
    elapsed_ms: number;
    status?: number;
    body_length?: number;
  };
  error?: {
    /**
     * Discriminator from `classifyBridgeError`. `'protocol'` covers
     * generic FetchproxyProtocolError (no_tab, domain_denied, etc.) —
     * the label compass historically called `'transport'`.
     */
    kind: 'timeout' | 'bridge_down' | 'http' | 'protocol' | 'other';
    message: string;
    /** Role at the moment of failure. Sourced from the typed error (0.8.0+) when present, else `bridgeStatus()`. */
    role_at_failure?: 'host' | 'peer' | null;
    /** Port at the moment of failure. Sourced from the typed error (0.8.0+). */
    port_at_failure?: number;
    /** Actual elapsed milliseconds for this call (from the typed error when available, else measured). */
    elapsed_ms?: number;
    /**
     * Server-authored next-step hint on FetchproxyBridgeDownError
     * (0.8.0+). Distinct from `hint` below — that one is compass's own
     * end-to-end guidance; this one is the bridge author's text.
     */
    bridge_hint?: string;
  };
  /** Plain-English next-step suggestion derived from the result. */
  hint: string;
}

const PROBE_PATH = '/robots.txt';

function hintFor(args: {
  ok: boolean;
  role: 'host' | 'peer' | null;
  errorKind?: HealthcheckResult['error'] extends infer E
    ? E extends { kind: infer K }
      ? K
      : never
    : never;
}): string {
  if (args.ok) {
    return `Bridge round-tripped /robots.txt successfully. If real tools still hang, the problem is downstream of fetchproxy (Compass redirecting on login, behavioral challenge, etc.) — not the bridge.`;
  }
  // Order: specific error kinds first, then the generic role-based hint.
  // A FetchproxyBridgeDownError can fire with role=null (the bridge can
  // hand back the SW-eviction error before listen() has resolved); the
  // more-specific bridge_down hint must win over the generic
  // "never bound a role" message in that case.
  if (args.errorKind === 'bridge_down') {
    return `The fetchproxy browser extension's service worker is not responding. Chrome evicts extension service workers after ~30s idle by default — this looks like that case. Wake it by clicking the fetchproxy extension icon (or opening any compass.com tab and reloading), then retry. If it keeps happening, reload the extension from chrome://extensions.`;
  }
  if (args.role === null) {
    return `The bridge never bound a role. listen() may have failed silently on startup. Check stderr from compass-mcp for an error during start, and confirm port ${37149} isn't blocked.`;
  }
  if (args.errorKind === 'timeout') {
    return `Bridge is alive (role=${args.role}), but the request didn't get a response in time. Either (a) the fetchproxy browser extension isn't connected to this MCP yet — open the extension popup and check for a green dot next to "compass-mcp", or (b) the signed-in compass.com tab is sleeping / closed. Open compass.com in your browser, then retry.`;
  }
  if (args.errorKind === 'protocol' || args.errorKind === 'http') {
    return `The bridge returned a protocol error before any HTTP response. Most commonly: no compass.com tab is open, or the extension declined the request. Open compass.com, sign in, and retry.`;
  }
  return `Unexpected error — see the error.message field for details.`;
}

export function registerHealthcheckTools(
  server: McpServer,
  client: CompassClient
): void {
  server.registerTool(
    'compass_healthcheck',
    {
      title: 'Verify the fetchproxy bridge end-to-end',
      description:
        "Round-trips a small public Compass URL (/robots.txt) through the fetchproxy bridge and returns diagnostics: the bridge's role (host/peer/null), port, version, the elapsed round-trip time, and a plain-English hint that distinguishes 'bridge never came up' from 'extension not connected' from 'real Compass-side problem'. Call this when a real Compass tool times out and you want to know which hop failed. Read-only, no auth required.",
      annotations: {
        title: 'Verify the fetchproxy bridge end-to-end',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {},
    },
    async () => {
      // We read bridgeStatus() once at the bottom (after the probe) so
      // the freshness counters in the response include this very call.
      // Don't read it up front — that snapshot would be stale.
      const start = Date.now();
      let probe: HealthcheckResult['probe'] = {
        url: `https://www.compass.com${PROBE_PATH}`,
        elapsed_ms: 0,
      };
      let error: HealthcheckResult['error'];
      let ok = false;
      try {
        const html = await client.fetchHtml(PROBE_PATH);
        probe = {
          url: `https://www.compass.com${PROBE_PATH}`,
          elapsed_ms: Date.now() - start,
          status: 200, // fetchHtml throws on non-2xx; reaching here means 2xx
          body_length: html.length,
        };
        ok = true;
      } catch (e) {
        const measuredElapsedMs = Date.now() - start;
        // 0.8.0: `classifyBridgeError` replaces the `instanceof` ladder.
        // It enforces correct subclass-before-parent ordering once and
        // returns a stable string discriminator. Note compass's old
        // `'transport'` arm maps to `'protocol'` in the helper's
        // vocabulary — same condition, new label.
        const kind = classifyBridgeError(e);
        const message = e instanceof Error ? e.message : String(e);
        // 0.8.0 typed errors carry role/port/elapsedMs directly — pull
        // them off here (source of truth for THIS throw) rather than
        // re-reading bridgeStatus() afterwards, which can drift if
        // anything else races on the bridge between throw and snapshot.
        let elapsedMs: number | undefined;
        let roleAtFailure: 'host' | 'peer' | null | undefined;
        let portAtFailure: number | undefined;
        let bridgeHint: string | undefined;
        if (e instanceof FetchproxyTimeoutError) {
          elapsedMs = e.elapsedMs;
          roleAtFailure = e.role;
          portAtFailure = e.port;
        } else if (e instanceof FetchproxyBridgeDownError) {
          roleAtFailure = e.role;
          portAtFailure = e.port;
          bridgeHint = e.hint;
        }
        error = {
          kind,
          message,
          ...(roleAtFailure !== undefined ? { role_at_failure: roleAtFailure } : {}),
          ...(portAtFailure !== undefined ? { port_at_failure: portAtFailure } : {}),
          ...(elapsedMs !== undefined ? { elapsed_ms: elapsedMs } : {}),
          ...(bridgeHint !== undefined ? { bridge_hint: bridgeHint } : {}),
        };
        probe = { ...probe, elapsed_ms: elapsedMs ?? measuredElapsedMs };
      }
      // Re-read after the probe — the server's bridgeHealth() counters
      // just updated, so this snapshot includes this very call.
      const postProbeBridge = client.bridgeStatus();
      // If the typed error didn't supply role_at_failure (e.g. an
      // 'other' kind, or a bare FetchproxyProtocolError without a
      // role field), fall back to the post-probe snapshot.
      if (error && error.role_at_failure === undefined) {
        error.role_at_failure = postProbeBridge.role;
      }
      const result: HealthcheckResult = {
        ok,
        bridge: {
          role: postProbeBridge.role,
          port: postProbeBridge.port,
          server_version: postProbeBridge.serverVersion,
          fetch_timeout_ms: postProbeBridge.fetchTimeoutMs,
          last_success_at: postProbeBridge.lastSuccessAt,
          last_failure_at: postProbeBridge.lastFailureAt,
          last_failure_reason: postProbeBridge.lastFailureReason,
          consecutive_failures: postProbeBridge.consecutiveFailures,
          last_extension_message_at: postProbeBridge.lastExtensionMessageAt,
        },
        probe,
        ...(error ? { error } : {}),
        hint: hintFor({
          ok,
          role: postProbeBridge.role,
          errorKind: error?.kind,
        }),
      };
      return textResult(result);
    }
  );
}
