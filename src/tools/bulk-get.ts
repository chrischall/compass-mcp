import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CompassClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  fetchListingRecord,
  format,
  type FormattedProperty,
} from './properties.js';

/**
 * `compass_bulk_get` — unbounded structured fetch for Compass listings.
 *
 * `compass_compare_properties` caps at 8 targets and ships a pivoted
 * summary table designed for side-by-side analysis. The real-world
 * "give me everything for these N saved homes" workflow needed neither
 * the cap nor the summary — 53-listing session, 7 sequential compare
 * calls. Issue #40 + #53 surfaced the pattern; this tool collapses it
 * to one round trip (or two if N > 200).
 *
 * Same per-target error capture as compare — one bad target never fails
 * the whole call. Same `include_description` default-off context-savings
 * behavior as `compass_get_property` (#34). No summary table — that's
 * `compass_compare_properties`' job.
 */

/**
 * Upper bound on `targets[]`. 200 covers realistic saved-home batches
 * while keeping the concurrent fan-out from slamming the bridge.
 */
export const BULK_GET_MAX = 200;

export interface BulkGetTarget {
  listing_id_sha?: string;
  url?: string;
}

interface BulkGetRow {
  listing_id_sha?: string;
  url?: string;
  property?: FormattedProperty;
  error?: string;
}

export function registerBulkGetTools(
  server: McpServer,
  client: CompassClient
): void {
  server.registerTool(
    'compass_bulk_get',
    {
      title: 'Bulk-fetch Compass listings by url or listing_id_sha',
      description:
        `Fetch up to ${BULK_GET_MAX} Compass listings in a single call. Returns one structured row per input target ` +
        '(no side-by-side summary table — use `compass_compare_properties` for that). Each row is either ' +
        '`{ listing_id_sha, url, property }` on success or `{ listing_id_sha, url, error }` on failure — one bad ' +
        'target never fails the whole call. Targets accept the same `url` / `listing_id_sha` shape as `compass_get_property`. ' +
        'Calls fan out concurrently. `extracted_features` is populated per row. The raw `description` is omitted by ' +
        'default — pass `include_description: true` to keep it.',
      annotations: {
        title: 'Bulk-fetch Compass listings',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        targets: z
          .array(
            z
              .object({
                url: z
                  .string()
                  .optional()
                  .describe(
                    'Compass homedetails URL or path (preferred — no resolver round-trip needed).'
                  ),
                listing_id_sha: z
                  .string()
                  .optional()
                  .describe(
                    'Compass listing identifier. Sufficient on its own — the tool resolves the address slug internally via site search before fetching.'
                  ),
              })
              .passthrough()
          )
          .min(1)
          .max(BULK_GET_MAX)
          .describe(
            `Up to ${BULK_GET_MAX} targets to fetch. For higher counts, batch into multiple calls.`
          ),
        include_description: z
          .boolean()
          .optional()
          .describe(
            'Include the raw `description` on each row. Defaults to `false` — `extracted_features` is always populated.'
          ),
      },
    },
    async ({ targets, include_description }) => {
      const ts = targets as BulkGetTarget[];
      const rows: BulkGetRow[] = await Promise.all(
        ts.map(async (t) => {
          const row: BulkGetRow = {
            listing_id_sha: t.listing_id_sha,
            url: t.url,
          };
          try {
            const { listing } = await fetchListingRecord(client, t);
            row.listing_id_sha = listing.listingIdSHA;
            row.url = listing.pageLink
              ? `https://www.compass.com${listing.pageLink}`
              : row.url;
            row.property = format(listing, {
              includeDescription: include_description,
            });
          } catch (e) {
            row.error = e instanceof Error ? e.message : String(e);
          }
          return row;
        })
      );
      return textResult({
        count: rows.length,
        rows,
      });
    }
  );
}
