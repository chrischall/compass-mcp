import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CompassClient } from '../client.js';
import { registerBridgeHealthcheckTool } from '@chrischall/mcp-utils/fetchproxy';

/**
 * Register `compass_healthcheck` — a no-op round-trip through the full bridge
 * so the user can tell, with ONE tool call, whether:
 *
 *   - compass-mcp's WebSocket bridge is up (`bridge.role` non-null)
 *   - the fetchproxy browser extension is connected (request reaches a tab and
 *     a response comes back)
 *   - the active compass.com tab is responsive (the fetch resolved in time)
 *
 * Probe target: `/robots.txt` on compass.com — small (~150 bytes), public (no
 * auth), served from Compass's edge — so a failure here cleanly isolates the
 * bridge from compass.com's own auth/SSR pipeline.
 *
 * The probe loop, error classification, post-probe bridge projection, result
 * shape, and the actionable hint ladder all live in mcp-utils'
 * `registerBridgeHealthcheckTool` (the /fetchproxy subpath). compass owns only
 * the per-site bits: the probe path, host label, and probe fn (which exercises
 * the same `client.fetchHtml` path real tools use, sign-in guards and all).
 *
 * The factory's hint ladder reads the REAL configured port from
 * `bridgeHealth()` — not a hardcoded 37149 — so a non-default `COMPASS_WS_PORT`
 * surfaces the correct port in the "never bound a role" guidance.
 */
export function registerHealthcheckTools(
  server: McpServer,
  client: CompassClient
): void {
  registerBridgeHealthcheckTool({
    server,
    prefix: 'compass',
    probePath: '/robots.txt',
    hostLabel: 'www.compass.com',
    transport: {
      runProbe: (fetchFn, probePath) => client.runProbe(fetchFn, probePath),
      status: () => client.bridgeStatus(),
    },
    probeFn: (path) => client.fetchHtml(path),
  });
}
