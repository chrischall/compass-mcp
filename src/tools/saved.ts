import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CompassClient } from '../client.js';
import { textResult } from '../mcp.js';

/**
 * Compass account surfaces (favorites + saved searches) are a known
 * v0.1.0 gap. Both the consumer dashboard at /overview/favorites and
 * the saved-searches page are fully client-rendered SPAs — they don't
 * embed listing data into the initial HTML, and Compass hasn't yet
 * exposed a public JSON path we can call from a browser session.
 *
 * Probed live 2026-05-24: /saved-listings/, /favorites/, /collections/,
 * /api/v1/listings/favorites, /api/v1/user_collections, /graphql, and
 * about a dozen sibling patterns all returned 404. The favorites page
 * does load data — it just does so via auth-scoped GraphQL fired after
 * React boots, which we can't observe from a one-shot fetchHtml.
 *
 * For now, the tools throw a clear "not yet supported" error. A future
 * version can land them once the right endpoint is identified — likely
 * by reverse-engineering Compass's internal GraphQL or by adding a
 * Pattern-B bootstrap call where the extension intercepts the in-tab
 * GraphQL response.
 */

const NOT_YET_SUPPORTED =
  "compass-mcp v0.1.0 doesn't yet wire up saved listings / saved searches. " +
  "Compass renders these pages via an auth-scoped GraphQL endpoint that " +
  "isn't reachable from a one-shot fetchproxy call. Track the issue at " +
  'https://github.com/chrischall/compass-mcp/issues — a future version will land this once the endpoint is identified.';

export function registerSavedTools(
  server: McpServer,
  _client: CompassClient
): void {
  server.registerTool(
    'compass_get_saved_homes',
    {
      title: 'Get my saved (favorited) Compass homes',
      description:
        'Not yet supported in v0.1.0 — Compass renders /overview/favorites via an auth-scoped GraphQL we have not yet identified. Throws a clear error explaining the limitation.',
      annotations: {
        title: 'Get my saved (favorited) Compass homes',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {},
    },
    async () => {
      throw new Error(NOT_YET_SUPPORTED);
    }
  );

  server.registerTool(
    'compass_get_saved_searches',
    {
      title: 'Get my saved Compass searches',
      description:
        'Not yet supported in v0.1.0 — Compass renders saved searches via an auth-scoped GraphQL we have not yet identified. Throws a clear error explaining the limitation.',
      annotations: {
        title: 'Get my saved Compass searches',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {},
    },
    async () => {
      throw new Error(NOT_YET_SUPPORTED);
    }
  );
}

// Marker to keep `textResult` import for forward-compat when we wire
// the tools properly.
export const __reservedForLater = textResult;
