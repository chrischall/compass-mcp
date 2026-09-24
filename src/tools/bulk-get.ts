import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  BRIDGE_CONCURRENCY,
  classifyRowError,
  retryOnceOnTimeout,
} from '@chrischall/mcp-utils/fetchproxy';
import { runBoundedBatch } from '@chrischall/mcp-utils';
import type { CompassClient } from '../client.js';
import { minifiedResult } from '../mcp.js';
import {
  OVERALL_DEADLINE_MS,
  guardClient,
  pendingMessage,
  type BulkTuning,
} from './bounded-batch.js';
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
  /**
   * Transport-fault marker (issue #73). Present ONLY when the per-row
   * failure was a bridge timeout (after the one-shot retry burned) or
   * an unreachable bridge — categorically NOT a genuine no-listing.
   * Mirrors the `compass_resolve_addresses` discipline (#85): a row
   * with `status` is retryable, not a clean miss. A genuine miss
   * (parse failure, restricted listing, protocol fault) carries only
   * `error` with no `status`/`retryable`.
   *
   * `pending` (fleet-audit#927): the overall deadline cut the row off
   * before it settled — also retryable, also NOT a miss.
   */
  status?: 'timeout' | 'bridge_down' | 'pending';
  retryable?: true;
}

export function registerBulkGetTools(
  server: McpServer,
  client: CompassClient,
  tuning: BulkTuning = {}
): void {
  const overallDeadlineMs = tuning.overallDeadlineMs ?? OVERALL_DEADLINE_MS;
  server.registerTool(
    'compass_bulk_get',
    {
      title: 'Bulk-fetch Compass listings by url or listing_id_sha',
      description:
        `Fetch up to ${BULK_GET_MAX} Compass listings in a single call. Returns one structured row per input target ` +
        '(no side-by-side summary table — use `compass_compare_properties` for that). Each row is either ' +
        '`{ listing_id_sha, url, property }` on success or `{ listing_id_sha, url, error }` on failure — one bad ' +
        'target never fails the whole call. When the failure was a bridge timeout (after one retry) or an unreachable ' +
        'bridge (issue #73), the row also carries `{ status: "timeout" | "bridge_down", retryable: true }` — that is NOT ' +
        'a missing listing, so retry it (a cold bridge usually succeeds on the second call) rather than concluding ' +
        'Compass has no record. Targets accept the same `url` / `listing_id_sha` shape as `compass_get_property`. ' +
        'Calls fan out concurrently. The whole call is bounded by an overall deadline: a slow or hung row never wedges it — ' +
        'any row still unsettled when the deadline is reached comes back as `{ status: "pending", retryable: true, error }` ' +
        'alongside a top-level `pending` count, so re-run just those targets. `extracted_features` is populated per row. The raw `description` is omitted by ' +
        'default — pass `include_description: true` to keep it.',
      annotations: {
        title: 'Bulk-fetch Compass listings',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
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
                    'Compass listing identifier. Sufficient on its own — the tool fetches /listing/<sha>/view, which 302-redirects to the slugged homedetails page (no extra lookup).'
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
      }),
    },
    async ({ targets, include_description }) => {
      const ts = targets as BulkGetTarget[];
      // Bounded fan-out + one-shot timeout retry — hoisted from
      // @fetchproxy/server 0.9.x. Unbounded Promise.all over 100+
      // targets was empirically slamming the bridge (round-3 #78
      // observed Zillow timing out 7-of-20 at unlimited concurrency,
      // 20-of-20 clean at 6); compass joins the same cap. The retry
      // wrapper buys back the rotating-tab tax — a single timeout on
      // a stale tab usually succeeds on the second attempt.
      //
      // fleet-audit#927: `runBoundedBatch` adds an overall deadline so a
      // stale tab can't hold the call past the MCP client's request
      // deadline and lose every completed row; unsettled rows come back
      // `pending`. `guardClient` stops abandoned rows dialling the bridge.
      const rows: BulkGetRow[] = await runBoundedBatch<BulkGetTarget, BulkGetRow>(
        ts,
        async (t, signal) => {
          const rowClient = guardClient(client, signal);
          const row: BulkGetRow = {
            listing_id_sha: t.listing_id_sha,
            url: t.url,
          };
          try {
            const { listing } = await retryOnceOnTimeout(() =>
              fetchListingRecord(rowClient, t)
            );
            row.listing_id_sha = listing.listingIdSHA;
            row.url = listing.pageLink
              ? `https://www.compass.com${listing.pageLink}`
              : row.url;
            row.property = format(listing, {
              includeDescription: include_description,
            });
          } catch (e) {
            // #73: classify the per-row failure with the cohort-standard
            // `classifyRowError` (@fetchproxy/server) instead of an
            // ad-hoc `e.message`. It runs AFTER `retryOnceOnTimeout` has
            // already burned its one-shot retry, so a `timeout` here
            // means the bridge stayed unresponsive across two attempts.
            // A transport fault (timeout / bridge_down) is NOT a genuine
            // miss — flag it `retryable` with a distinct `status` so a
            // caller never reads a cold-bridge blip as "Compass has no
            // listing". `protocol` / `other` keep the plain `error`
            // (genuine miss / parse failure), preserving prior behavior.
            const { kind, message } = classifyRowError(e);
            row.error = message;
            if (kind === 'timeout' || kind === 'bridge_down') {
              row.status = kind;
              row.retryable = true;
            }
          }
          return row;
        },
        {
          deadlineMs: overallDeadlineMs,
          concurrency: BRIDGE_CONCURRENCY,
          onTimeout: (t) => ({
            listing_id_sha: t.listing_id_sha,
            url: t.url,
            status: 'pending',
            retryable: true,
            error: pendingMessage('compass_bulk_get'),
          }),
        }
      );
      const pending = rows.filter((r) => r.status === 'pending').length;
      return minifiedResult({
        count: rows.length,
        ...(pending > 0 ? { pending } : {}),
        rows,
      });
    }
  );
}
