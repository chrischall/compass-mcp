import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CompassClient } from '../client.js';
import { textResult } from '../mcp.js';
import { FetchproxyTimeoutError } from '../transport-fetchproxy.js';

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
  };
  probe: {
    url: string;
    elapsed_ms: number;
    status?: number;
    body_length?: number;
  };
  error?: {
    kind: 'timeout' | 'transport' | 'other';
    message: string;
    /** When the timeout fired, the role at the moment of failure. */
    role_at_failure?: 'host' | 'peer' | null;
  };
  /** Plain-English next-step suggestion derived from the result. */
  hint: string;
}

const PROBE_PATH = '/robots.txt';

function hintFor(args: {
  ok: boolean;
  role: 'host' | 'peer' | null;
  errorKind?: 'timeout' | 'transport' | 'other';
}): string {
  if (args.ok) {
    return `Bridge round-tripped /robots.txt successfully. If real tools still hang, the problem is downstream of fetchproxy (Compass redirecting on login, behavioral challenge, etc.) — not the bridge.`;
  }
  if (args.role === null) {
    return `The bridge never bound a role. listen() may have failed silently on startup. Check stderr from compass-mcp for an error during start, and confirm port ${37149} isn't blocked.`;
  }
  if (args.errorKind === 'timeout') {
    return `Bridge is alive (role=${args.role}), but the request didn't get a response in time. Either (a) the fetchproxy browser extension isn't connected to this MCP yet — open the extension popup and check for a green dot next to "compass-mcp", or (b) the signed-in compass.com tab is sleeping / closed. Open compass.com in your browser, then retry.`;
  }
  if (args.errorKind === 'transport') {
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
      const bridge = client.bridgeStatus();
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
        const elapsedMs = Date.now() - start;
        if (e instanceof FetchproxyTimeoutError) {
          error = {
            kind: 'timeout',
            message: e.message,
            role_at_failure: e.role,
          };
        } else if (e instanceof Error && /fetchproxy transport error/.test(e.message)) {
          error = { kind: 'transport', message: e.message };
        } else {
          error = {
            kind: 'other',
            message: e instanceof Error ? e.message : String(e),
          };
        }
        probe = { ...probe, elapsed_ms: elapsedMs };
      }
      const result: HealthcheckResult = {
        ok,
        bridge: {
          role: bridge.role,
          port: bridge.port,
          server_version: bridge.serverVersion,
          fetch_timeout_ms: bridge.fetchTimeoutMs,
        },
        probe,
        ...(error ? { error } : {}),
        hint: hintFor({
          ok,
          role: bridge.role,
          errorKind: error?.kind,
        }),
      };
      return textResult(result);
    }
  );
}
