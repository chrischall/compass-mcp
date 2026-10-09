import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  BRIDGE_CONCURRENCY,
  classifyRowError,
  retryOnceOnTimeout,
} from '@chrischall/mcp-utils/fetchproxy';
import { runBoundedBatch } from '@chrischall/mcp-utils';
import type { CompassClient } from '../client.js';
import { viewArg, viewResponse } from '../view.js';
import { guardMethods, runRowBatch } from '@chrischall/realty-core';
import { OVERALL_DEADLINE_MS, type BulkTuning } from './bounded-batch.js';
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
        '`{ listing_id_sha, url, status: "ok", property }` on success or `{ listing_id_sha, url, status, error_kind, retryable, error }` ' +
        'on failure (`status` = `error_kind`) — one bad target never fails the whole call. `retryable: true` (a bridge `timeout` after ' +
        'one retry, an unreachable `bridge_down`, issue #73) is NOT a missing listing, so retry it (a cold bridge usually succeeds on the ' +
        'second call) rather than concluding Compass has no record; `protocol` / `other` are real misses. Targets accept the same `url` / `listing_id_sha` shape as `compass_get_property`. ' +
        'Calls fan out concurrently. The whole call is bounded by an overall deadline: a slow or hung row never wedges it — ' +
        'any row still unsettled when the deadline is reached comes back as `{ status: "pending", retryable: true, error }` ' +
        'alongside a top-level `pending` count, so re-run just those targets. The envelope also reports `count` / `ok` / `errored`. `extracted_features` is populated per row. The raw `description` is omitted by ' +
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
        view: viewArg(),
      }),
    },
    async ({ targets, include_description, view }) => {
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
      // `pending`.
      //
      // fleet-audit#1091: realty-core `runRowBatch` owns the envelope —
      // input-ordered rows, `pending` backfill, error rows classified with
      // `status` = `error_kind` + `retryable` (timeout / bridge_down /
      // pending retryable; protocol / other a real miss), and
      // `{ count, ok, errored, pending?, rows }`. `guardMethods` (the
      // generalised #927 `guardClient`) stops an abandoned row dialling
      // the bridge.
      const envelope = await runRowBatch(
        ts,
        async (t, signal) => {
          const rowClient = guardMethods(client, signal, ['fetchHtml', 'fetchJson']);
          const { listing } = await fetchListingRecord(rowClient, t);
          return {
            listing_id_sha: listing.listingIdSHA,
            url: listing.pageLink
              ? `https://www.compass.com${listing.pageLink}`
              : t.url,
            property: format(listing, {
              includeDescription: include_description,
            }),
          };
        },
        {
          kit: { runBoundedBatch, classifyRowError, retryOnceOnTimeout },
          toolLabel: 'compass_bulk_get',
          rowBase: (t) => ({ listing_id_sha: t.listing_id_sha, url: t.url }),
          deadlineMs: overallDeadlineMs,
          concurrency: BRIDGE_CONCURRENCY,
          resultsKey: 'rows',
        }
      );
      return viewResponse(view, envelope);
    }
  );
}
