import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CompassClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractPidFromUrl } from '../url.js';
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

/**
 * Shared cross-MCP price-history enum (issue #48). Each sister
 * real-estate MCP exposes its own price-history schema; this enum is
 * the union that callers can rely on regardless of upstream provider.
 */
export type NormalizedEventType =
  | 'Listed'
  | 'PriceChange'
  | 'Pending'
  | 'Contingent'
  | 'Sold'
  | 'Withdrawn'
  | 'Relisted'
  | 'Delisted';

export interface NormalizedEvent {
  date: string;
  type: NormalizedEventType;
  price?: number;
  /** Percent change from the previous priced event, rounded to 0.1. */
  price_change_pct?: number;
  source_mls?: string;
}

/**
 * Map a Compass `localizedStatus` (e.g. "Listed", "Price Change",
 * "Sold", "Off Market") to a shared cross-MCP type. Returns undefined
 * for shapes we don't recognize — we drop those rather than guess.
 */
export function normalizeEventType(
  localizedStatus: string | undefined
): NormalizedEventType | undefined {
  if (!localizedStatus) return undefined;
  const s = localizedStatus.toLowerCase().trim();
  // Order matters where a value matches multiple regexes — list the
  // more specific cases first.
  if (/relist|re-?list/.test(s)) return 'Relisted';
  if (/(^listed$|active|coming soon|new listing|for sale)/.test(s)) return 'Listed';
  if (/price.?(change|decrease|increase|reduced|adjust)/.test(s)) return 'PriceChange';
  if (/pending/.test(s)) return 'Pending';
  if (/contingent/.test(s)) return 'Contingent';
  if (/(^sold$|closed|completed)/.test(s)) return 'Sold';
  if (/withdrawn/.test(s)) return 'Withdrawn';
  if (/(delisted|off market|expired|cancel|temporar)/.test(s)) return 'Delisted';
  return undefined;
}

/**
 * Merge `events[]` + `history[]` into a single chronological array of
 * normalized events, computing `price_change_pct` relative to the
 * previous priced event. (Issue #48.)
 */
export function buildEventsNormalized(
  events: RawListingHistoryEvent[],
  history: RawListingHistoryEvent[]
): NormalizedEvent[] {
  type Pair = { raw: RawListingHistoryEvent; type: NormalizedEventType };
  const recognized: Pair[] = [];
  // Dedup belt-and-suspenders: if Compass ever surfaces the current
  // listing's events in history[] as well, collapse duplicates by
  // (timestamp, type, price) tuple. Today history[] is prior-listing
  // events only, but this is cheap insurance.
  const seen = new Set<string>();
  for (const e of [...events, ...history]) {
    const type = normalizeEventType(e.localizedStatus);
    if (!type || typeof e.timestamp !== 'number') continue;
    const key = `${e.timestamp}|${type}|${typeof e.price === 'number' ? e.price : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    recognized.push({ raw: e, type });
  }
  // Stable sort by timestamp ascending.
  recognized.sort((a, b) => (a.raw.timestamp ?? 0) - (b.raw.timestamp ?? 0));
  let lastPrice: number | undefined;
  const out: NormalizedEvent[] = [];
  for (const { raw, type } of recognized) {
    const entry: NormalizedEvent = {
      date: new Date(raw.timestamp as number).toISOString().slice(0, 10),
      type,
    };
    if (typeof raw.price === 'number') entry.price = raw.price;
    if (raw.source?.sourceDisplayName) entry.source_mls = raw.source.sourceDisplayName;
    // price_change_pct: compare to the *previous priced* event,
    // independent of `type`. (A "Pending" with no price won't reset
    // the comparison baseline.)
    if (
      typeof raw.price === 'number' &&
      typeof lastPrice === 'number' &&
      lastPrice > 0
    ) {
      entry.price_change_pct =
        Math.round(((raw.price - lastPrice) / lastPrice) * 1000) / 10;
    }
    if (typeof raw.price === 'number') lastPrice = raw.price;
    out.push(entry);
  }
  return out;
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
        "Full listing history for a Compass property — Listed / Sold / Pending / Price Change / Delisted events with date, price, and MLS attribution. Returns three arrays: `events` covers this listing's events, `history` aggregates events from prior listings of the same property, and `events_normalized` merges both into a shared cross-MCP schema (`{date, type, price?, price_change_pct?, source_mls?}` with a fixed type enum: Listed | PriceChange | Pending | Contingent | Sold | Withdrawn | Relisted | Delisted). Pass either `url` (the full Compass homedetails URL or path) or `listing_id_sha` alone — sha-only calls are resolved internally via Compass site search. Note: most of this data is already returned inline on `compass_get_property` (the events[] / history[] arrays live on the same listing record); call this tool only when you want the merged + normalized timeline. Read-only; safe to call repeatedly.",
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
            'Compass homedetails URL or path (preferred — no resolver round-trip needed).'
          ),
        listing_id_sha: z
          .string()
          .optional()
          .describe(
            'Compass listing identifier. Sufficient on its own — the tool resolves the address slug internally via site search before fetching.'
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
      // events_normalized merges both arrays into the shared cross-MCP
      // schema documented in issue #48. The original `events` /
      // `history` arrays stay for back-compat.
      const eventsNormalized = buildEventsNormalized(
        listing.events ?? [],
        listing.history ?? []
      );
      return textResult({
        listing_id_sha: listing.listingIdSHA,
        // `pid` is the stable short ID (from navigationPageLink's
        // `_pid/` form) — survives re-listings; the `listing_id_sha`
        // above does not. See issue #27.
        pid: extractPidFromUrl(listing.navigationPageLink),
        url: listing.pageLink
          ? `https://www.compass.com${listing.pageLink}`
          : undefined,
        events_count: events.length,
        history_count: history.length,
        events,
        history,
        events_normalized: eventsNormalized,
      });
    }
  );
}
