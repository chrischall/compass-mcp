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
import { guardMethods, pivotSummary, runRowBatch } from '@chrischall/realty-core';
import { OVERALL_DEADLINE_MS, type BulkTuning } from './bounded-batch.js';
import {
  fetchListingRecord,
  format,
  type FormattedProperty,
} from './properties.js';

/**
 * Fetch + align N Compass properties for side-by-side comparison.
 *
 * Per-target failures don't fail the whole call — each row reports an
 * `error` string with the message and the per-row `property` is null.
 * Fetches are concurrent.
 */

export interface CompareTarget {
  listing_id_sha?: string;
  url?: string;
}

interface CompareRow {
  listing_id_sha?: string;
  url?: string;
  property?: FormattedProperty;
}

interface SummaryRow {
  field: string;
  values: Array<string | number | null>;
}

const SUMMARY_FIELDS: Array<keyof FormattedProperty> = [
  'address',
  'neighborhood',
  'city',
  'state',
  'zip',
  'price',
  'price_per_sqft',
  'beds',
  'baths',
  'sqft',
  'lot_size_sqft',
  'lot_size_acres',
  'localized_status',
];

export function buildSummary(rows: ReadonlyArray<CompareRow>): SummaryRow[] {
  // realty-core `pivotSummary` (fleet-audit#1091): the row's value
  // verbatim, `undefined` / failed row → null.
  return pivotSummary<FormattedProperty>(rows, SUMMARY_FIELDS) as SummaryRow[];
}

export function registerCompareTools(
  server: McpServer,
  client: CompassClient,
  tuning: BulkTuning = {}
): void {
  const overallDeadlineMs = tuning.overallDeadlineMs ?? OVERALL_DEADLINE_MS;
  server.registerTool(
    'compass_compare_properties',
    {
      title: 'Compare Compass properties side-by-side',
      description:
        "Fetch 2 or more Compass properties and align their facts side-by-side. Each target may supply `url` (a full Compass homedetails URL or path) or `listing_id_sha` alone — sha-only targets fetch /listing/<sha>/view, which redirects to the homedetails page. Returns the full per-property record per row (with `extracted_features` populated). Per-target errors are captured per-row — one bad target will not fail the whole call; a failed row carries `status` = `error_kind` (`timeout` / `bridge_down` / `protocol` / `other`), `retryable` and `error`, and the envelope reports `count` / `ok` / `errored`. Calls are concurrent, and the whole call is bounded by an overall deadline: any row still unsettled when it is reached comes back as `{ status: \"pending\", retryable: true, error }` with a top-level `pending` count — re-run just those targets. The raw `description` is omitted from each row by default — pass `include_description: true` to keep it. The redundant `summary` table is also opt-in via `include_summary: true` — by default only `results[]` is returned, which already carries every fact.",
      annotations: {
        title: 'Compare Compass properties side-by-side',
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
                    'Compass listing identifier (the SHA inside `<sha>_lid`). Sufficient on its own — the tool fetches /listing/<sha>/view, which 302-redirects to the slugged homedetails page (no extra lookup).'
                  ),
              })
              .passthrough()
          )
          .min(2)
          .max(25)
          .describe(
            'Array of 2–25 properties to compare. (Cap raised from 8 to 25 in #53; for unbounded structured fetch without the summary table, use `compass_bulk_get`.)'
          ),
        include_description: z
          .boolean()
          .optional()
          .describe(
            'Include the raw `description` (Compass marketing copy) on each row. Defaults to `false` — `extracted_features` is always populated.'
          ),
        include_summary: z
          .boolean()
          .optional()
          .describe(
            'Include the pivoted `summary` table (one row per compared field, one column per listing). Defaults to `false` — `results[].property.*` already carries every fact and the summary was roughly 30% of response weight. Useful only for human-readable rendering.'
          ),
        view: viewArg(),
      }),
    },
    async ({ targets, include_description, include_summary, view }) => {
      const ts = targets as CompareTarget[];
      // Bounded fan-out + one-shot timeout retry — same helpers the
      // bulk-get tool uses (`@fetchproxy/server` 0.9.x). Compare caps
      // at 25 targets; that's well above BRIDGE_CONCURRENCY=6, so the
      // bounded fan-out still bites on realistic batches. Joining the
      // cohort cap keeps cross-MCP behavior consistent.
      //
      // fleet-audit#927: `runBoundedBatch` bounds the whole call with an
      // overall deadline (unsettled rows come back `pending`) and
      //
      // fleet-audit#1091: the row envelope is realty-core `runRowBatch`
      // (see bulk-get.ts); `guardMethods` is the generalised #927 guard.
      const envelope = await runRowBatch(
        ts,
        async (t, signal) => {
          const rowClient = guardMethods(client, signal, ['fetchHtml', 'fetchJson']);
          const { listing } = await fetchListingRecord(rowClient, t);
          return {
            listing_id_sha: listing.listingIdSHA,
            url: listing.pageLink
              ? `https://www.compass.com${listing.pageLink}`
              : undefined,
            property: format(listing, {
              includeDescription: include_description,
            }),
          };
        },
        {
          kit: { runBoundedBatch, classifyRowError, retryOnceOnTimeout },
          toolLabel: 'compass_compare_properties',
          rowBase: (t) => ({ listing_id_sha: t.listing_id_sha, url: t.url }),
          deadlineMs: overallDeadlineMs,
          concurrency: BRIDGE_CONCURRENCY,
        }
      );
      const body: typeof envelope & { summary?: SummaryRow[] } = envelope;
      if (include_summary === true) body.summary = buildSummary(envelope.results);
      return viewResponse(view, body);
    }
  );
}
