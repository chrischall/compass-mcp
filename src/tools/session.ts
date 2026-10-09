import type { McpServer } from '@modelcontextprotocol/server';
import {
  registerSessionTools as registerSharedSessionTools,
  type SessionRegistry,
} from '@chrischall/mcp-utils/session';

/**
 * MCP tool surface for the Compass session registry.
 *
 * Three tools, all `compass`-prefixed:
 *
 * - `compass_register_session` — register (or refresh) an authenticated
 *   session keyed by `account_identity`. Pass `mark_active: true` to
 *   make it the active session in the same call.
 * - `compass_set_active_session` — switch which registered session
 *   subsequent calls treat as active. (Issue #41.)
 * - `compass_get_session_context` — diagnostic: every registered session
 *   plus the current `active_session_id`. (Issue #42.)
 *
 * The trio is the fleet-shared `registerSessionTools` from
 * `@chrischall/mcp-utils/session`, bound to the `compass` prefix. It's
 * wrapped here (rather than called directly in index.ts) so the
 * `compass`-specific prefix/label live in one place and the
 * `(server, registry)` call site stays a plain registrar.
 *
 * Migration notes (vs. the hand-rolled registry this replaces):
 *
 * - The old registry lived inside `CompassClient` and stored live
 *   transports; `CompassClient` now holds its ONE transport directly
 *   (same shape as the zillow/redfin/homes siblings) and the registry is
 *   a labelled-context layer the caller uses to track which account it's
 *   working with — not a transport-level multiplexer. The physical
 *   fetchproxy bridge still routes to whichever browser tab the
 *   extension is bound to right now.
 * - The old `compass_get_session_context` projected the bridge's health
 *   (role / port / server_version / fetch_timeout_ms / last-success /
 *   last-failure counters) into every session row. That projection was
 *   per-bridge data, not per-session data — it's surfaced by
 *   `compass_healthcheck` (via `client.bridgeStatus()`), which reports
 *   the same fields for the one live bridge.
 */
export function registerSessionTools(
  server: McpServer,
  registry: SessionRegistry
): void {
  registerSharedSessionTools(withAdditiveSessionWrites(server), registry, {
    prefix: 'compass',
    serviceLabel: 'Compass',
    // Nothing in compass-mcp reads the registry to route a request — every
    // call rides the one bound browser tab — so the descriptions must not
    // promise routing (fleet-audit#1092).
    routing: 'label-only',
    labelOnlyNote:
      'Every compass tool call goes through whichever browser tab the ContextMint Bridge ' +
      'extension is signed into; to read a different account, sign that tab into it.',
  });
}

/**
 * The two session writes, classified by the inverse test. The shared
 * registrar (mcp-utils 3.0.0) sets `readOnlyHint: false` but no
 * `destructiveHint`, which the spec defaults to TRUE — so both were
 * published as destructive. Neither is: they touch only the process-local,
 * label-only registry (nothing routes on it, nothing reaches another person,
 * a restart clears it), and the one piece of prior state either replaces —
 * which session is active — is restored by `compass_set_active_session`.
 */
const ADDITIVE_SESSION_WRITES = new Set([
  'compass_register_session',
  'compass_set_active_session',
]);

/**
 * A view of `server` whose `registerTool` adds `destructiveHint: false` to
 * the session writes above and passes everything else through untouched.
 */
function withAdditiveSessionWrites(server: McpServer): McpServer {
  const registerTool = ((
    name: string,
    config: { annotations?: Record<string, unknown> },
    cb: unknown
  ) =>
    (server.registerTool as (n: string, c: unknown, f: unknown) => unknown)(
      name,
      ADDITIVE_SESSION_WRITES.has(name)
        ? { ...config, annotations: { ...config.annotations, destructiveHint: false } }
        : config,
      cb
    )) as McpServer['registerTool'];
  return new Proxy(server, {
    get(target, prop) {
      if (prop === 'registerTool') return registerTool;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
