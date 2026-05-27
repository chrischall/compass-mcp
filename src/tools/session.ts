import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CompassClient } from '../client.js';
import { textResult } from '../mcp.js';

/**
 * Session-management tools.
 *
 * `compass_get_session_context` returns every registered session along
 * with the active_session_id. Issue #42 — the single-session case
 * (one signed-in compass.com tab via the fetchproxy bridge, which is
 * what every install ships with today) reduces cleanly to a one-entry
 * sessions[] with active_session_id pointing at it.
 *
 * `compass_set_active_session` flips which registered session answers
 * future requests. Issue #41 — multi-session registration is the
 * forward-compatible scaffolding; registering additional sessions
 * requires fetchproxy bridge changes that are not part of this PR.
 */

interface SessionSummary {
  session_id: string;
  role: 'host' | 'peer' | null;
  port: number;
  server_version: string;
  fetch_timeout_ms: number;
  last_success_at: number | null;
  last_failure_at: number | null;
  last_failure_reason: string | null;
  consecutive_failures: number;
}

interface SessionContextResult {
  active_session_id: string;
  sessions: SessionSummary[];
}

function summarize(client: CompassClient): SessionContextResult {
  return {
    active_session_id: client.getActiveSessionId(),
    sessions: client.listSessions().map((s) => ({
      session_id: s.sessionId,
      role: s.status.role,
      port: s.status.port,
      server_version: s.status.serverVersion,
      fetch_timeout_ms: s.status.fetchTimeoutMs,
      last_success_at: s.status.lastSuccessAt,
      last_failure_at: s.status.lastFailureAt,
      last_failure_reason: s.status.lastFailureReason,
      consecutive_failures: s.status.consecutiveFailures,
    })),
  };
}

export function registerSessionTools(
  server: McpServer,
  client: CompassClient
): void {
  server.registerTool(
    'compass_get_session_context',
    {
      title: 'Inspect Compass session registry',
      description:
        'Return every registered Compass session along with the active_session_id. Today this is a single-session view — the shape ' +
        '(`{ active_session_id, sessions: [...] }`) is forward-compatible with multi-session support so callers can write one ' +
        'code path. Each session row includes the bridge role, port, last-success/last-failure counters, and the most recent ' +
        'failure reason. Read-only; no network call.',
      annotations: {
        title: 'Inspect Compass session registry',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {},
    },
    async () => textResult(summarize(client))
  );

  server.registerTool(
    'compass_set_active_session',
    {
      title: 'Choose which registered session answers subsequent requests',
      description:
        'Flip which registered Compass session is active. Subsequent tool calls go to the chosen session until this is called ' +
        "again. Throws when the session_id isn't registered. Today only a single session is registered at startup; this tool's " +
        'main job is forward-compatible scaffolding for multi-session support (#41). Returns the resulting session context ' +
        '(same shape as `compass_get_session_context`).',
      annotations: {
        title: 'Choose active Compass session',
        readOnlyHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        session_id: z
          .string()
          .min(1)
          .describe('A session_id from `compass_get_session_context`.'),
      },
    },
    async ({ session_id }) => {
      client.setActiveSession(session_id);
      return textResult(summarize(client));
    }
  );
}
