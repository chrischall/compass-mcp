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
        "Fetch 2 or more Compass properties and align their facts side-by-side. Each target may supply `url` (a full Compass homedetails URL or path) or `listing_id_sha` alone — sha-only targets are resolved internally via Compass site search before fetching. Returns the full per-property record per row (with `extracted_features` populated). Per-target errors are captured per-row — one bad target will not fail the whole call. Calls are concurrent. The raw `description` is omitted from each row by default — pass `include_description: true` to keep it. The redundant `summary` table is also opt-in via `include_summary: true` — by default only `results[]` is returned, which already carries every fact.",
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
          .max(8)
          .describe('Array of 2–8 properties to compare'),
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
      const rows: CompareRow[] = await Promise.all(
        ts.map(async (t) => {
          try {
            const { listing } = await fetchListingRecord(client, t);
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
            return {
              listing_id_sha: t.listing_id_sha,
              url: t.url,
              error: (e as Error).message,
            };
          }
        })
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
