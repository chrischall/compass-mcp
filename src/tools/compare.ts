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
        "Fetch 2 or more Compass properties and align their facts side-by-side. Each target must supply a `url` — the full Compass homedetails URL or path (e.g. from a compass_search_properties result's `url` field). `listing_id_sha` alone is NOT enough; Compass returns 410 Gone for the slug-less URL, surfaced as a per-row error here. Returns a compact summary table aligned by field (address, price, beds/baths, sqft, $/sqft, status, etc.) plus the full per-property record. Per-target errors are captured per-row — one bad target will not fail the whole call. Calls are concurrent.",
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
                    'Compass homedetails URL or path. Required per target — pass the `url` field from a compass_search_properties result.'
                  ),
                listing_id_sha: z
                  .string()
                  .optional()
                  .describe(
                    'The bare Compass listing identifier. INSUFFICIENT on its own — Compass returns 410 Gone for /homedetails/<sha>_lid/ without the address slug. Pass `url` instead.'
                  ),
              })
              .passthrough()
          )
          .min(2)
          .max(8)
          .describe('Array of 2–8 properties to compare'),
      },
    },
    async ({ targets }) => {
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
              property: format(listing),
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
      const summary = buildSummary(rows);
      return textResult({
        count: rows.length,
        summary,
        results: rows,
      });
    }
  );
}
