import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CompassClient } from '../client.js';
import { textResult } from '../mcp.js';
import {
  fetchListingRecord,
  type RawListingHistoryEvent,
} from './properties.js';

/**
 * Compass embeds price history as two arrays on the listing record:
 *
 *   - `events[]`: this listing's MLS / Compass events ("Listed",
 *     "Sold", "Pending", "Price Change", etc). Each entry carries a
 *     unix-ms `timestamp`, `price` (plain number), `status` /
 *     `localizedStatus`, and a `source` block with `sourceDisplayName`
 *     (e.g. "MLSLI"), `externalSourceName`, `externalSourceId`.
 *
 *   - `history[]`: a richer aggregate including events from prior
 *     listings (different `feedListingId`s). The homedetails UI uses
 *     this for the full timeline.
 *
 * We surface both. `events_count` and `history_count` are returned at
 * the top level for quick triage.
 */

export interface FormattedHistoryEvent {
  date?: string;
  event?: string;
  status?: number;
  price?: number;
  source?: string;
  source_id?: string;
  external_source?: string;
  feed_listing_id?: string;
}

export function formatHistoryEvent(
  raw: RawListingHistoryEvent
): FormattedHistoryEvent {
  return {
    date:
      typeof raw.timestamp === 'number'
        ? new Date(raw.timestamp).toISOString().slice(0, 10)
        : undefined,
    event: raw.localizedStatus,
    status: raw.status,
    price: typeof raw.price === 'number' ? raw.price : undefined,
    source: raw.source?.sourceDisplayName,
    source_id: raw.source?.externalSourceId,
    external_source: raw.source?.externalSourceName,
    feed_listing_id: raw.feedListingId,
  };
}

export function registerHistoryTools(
  server: McpServer,
  client: CompassClient
): void {
  server.registerTool(
    'compass_get_price_history',
    {
      title: 'Get Compass listing-history events',
      description:
        "Full listing history for a Compass property — Listed / Sold / Pending / Price Change / Delisted events with date, price, and MLS attribution. Returns two parallel arrays: `events` covers this listing's events, `history` aggregates events from prior listings of the same property. Pass `url` — the full Compass homedetails URL or path (e.g. from a compass_search_properties result's `url` field). `listing_id_sha` alone is NOT enough — Compass requires the address slug too and returns 410 Gone for the slug-less URL. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Get Compass listing-history events',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        url: z
          .string()
          .optional()
          .describe(
            'Compass homedetails URL or path. Required — pass the `url` field from a compass_search_properties result.'
          ),
        listing_id_sha: z
          .string()
          .optional()
          .describe(
            'The bare Compass listing identifier. INSUFFICIENT on its own — Compass returns 410 Gone for /homedetails/<sha>_lid/ without the address slug. Pass `url` instead.'
          ),
      },
    },
    async ({ url, listing_id_sha }) => {
      const { listing } = await fetchListingRecord(client, {
        url,
        listing_id_sha,
      });
      const events = (listing.events ?? []).map(formatHistoryEvent);
      const history = (listing.history ?? []).map(formatHistoryEvent);
      return textResult({
        listing_id_sha: listing.listingIdSHA,
        url: listing.pageLink
          ? `https://www.compass.com${listing.pageLink}`
          : undefined,
        events_count: events.length,
        history_count: history.length,
        events,
        history,
      });
    }
  );
}
