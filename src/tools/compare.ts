import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  BRIDGE_CONCURRENCY,
  classifyRowError,
  mapWithConcurrency,
  retryOnceOnTimeout,
} from '@chrischall/mcp-utils/fetchproxy';
import type { CompassClient } from '../client.js';
import { textResult } from '../mcp.js';
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
  error?: string;
  /**
   * Transport-fault marker (#73/#85). Present ONLY when the per-row
   * failure was a bridge timeout (after the one-shot retry burned) or an
   * unreachable bridge — categorically NOT a genuine no-listing. Mirrors
   * the `compass_bulk_get` / `compass_resolve_addresses` discipline: a
   * row with `status` is retryable, not a clean miss. A genuine miss
   * (parse failure, restricted listing, protocol fault) carries only
   * `error` with no `status`/`retryable`.
   */
  status?: 'timeout' | 'bridge_down';
  retryable?: true;
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

export function buildSummary(rows: CompareRow[]): SummaryRow[] {
  return SUMMARY_FIELDS.map((field) => ({
    field,
    values: rows.map((r) =>
      r.property
        ? ((r.property as unknown as Record<string, unknown>)[field] as
            | string
            | number
            | null
            | undefined) ?? null
        : null
    ),
  }));
}

export function registerCompareTools(
  server: McpServer,
  client: CompassClient
): void {
  server.registerTool(
    'compass_compare_properties',
    {
      title: 'Compare Compass properties side-by-side',
      description:
        "Fetch 2 or more Compass properties and align their facts side-by-side. Each target may supply `url` (a full Compass homedetails URL or path) or `listing_id_sha` alone — sha-only targets fetch /listing/<sha>/view, which redirects to the homedetails page. Returns the full per-property record per row (with `extracted_features` populated). Per-target errors are captured per-row — one bad target will not fail the whole call. Calls are concurrent. The raw `description` is omitted from each row by default — pass `include_description: true` to keep it. The redundant `summary` table is also opt-in via `include_summary: true` — by default only `results[]` is returned, which already carries every fact.",
      annotations: {
        title: 'Compare Compass properties side-by-side',
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
                    'Compass listing identifier. Sufficient on its own — the tool resolves the address slug internally via site search before fetching the homedetails page.'
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
      },
    },
    async ({ targets, include_description, include_summary }) => {
      const ts = targets as CompareTarget[];
      // Bounded fan-out + one-shot timeout retry — same helpers the
      // bulk-get tool uses (`@fetchproxy/server` 0.9.x). Compare caps
      // at 25 targets; that's well above BRIDGE_CONCURRENCY=6, so the
      // bounded fan-out still bites on realistic batches. Joining the
      // cohort cap keeps cross-MCP behavior consistent.
      const rows: CompareRow[] = await mapWithConcurrency(
        ts,
        BRIDGE_CONCURRENCY,
        async (t) => {
          try {
            const { listing } = await retryOnceOnTimeout(() =>
              fetchListingRecord(client, t)
            );
            return {
              listing_id_sha: listing.listingIdSHA,
              url: listing.pageLink
                ? `https://www.compass.com${listing.pageLink}`
                : undefined,
              property: format(listing, {
                includeDescription: include_description,
              }),
            };
          } catch (e) {
            // Share the cohort-standard error contract with
            // `compass_bulk_get` / `compass_resolve_addresses` (#73/#85).
            // `classifyRowError` runs AFTER `retryOnceOnTimeout` has burned
            // its one-shot retry, so a `timeout` here means the bridge
            // stayed unresponsive across two attempts. A transport fault
            // (timeout / bridge_down) is NOT a genuine miss — flag it
            // `retryable` with a distinct `status`. `protocol` / `other`
            // keep the plain `error` (genuine miss / parse failure).
            const { kind, message } = classifyRowError(e);
            const row: CompareRow = {
              listing_id_sha: t.listing_id_sha,
              url: t.url,
              error: message,
            };
            if (kind === 'timeout' || kind === 'bridge_down') {
              row.status = kind;
              row.retryable = true;
            }
            return row;
          }
        }
      );
      const body: {
        count: number;
        summary?: SummaryRow[];
        results: CompareRow[];
      } = {
        count: rows.length,
        results: rows,
      };
      if (include_summary === true) body.summary = buildSummary(rows);
      return textResult(body);
    }
  );
}
