import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CompassClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractUc } from '../page-state.js';
import { fetchListingRecord } from './properties.js';
import {
  findLolResults,
  formatHome,
  type FormattedHome,
  buildSearchPath,
} from './search.js';

/**
 * `compass_get_comparable_rentals` — surface nearby rental listings for
 * a Compass property. Issue #49.
 *
 * Compass exposes rentals through the same `/homes-for-sale/<slug>/
 * type-rental/` URL family as for-sale listings. Strategy:
 *   1. Fetch the target homedetails to lift city/state/zip.
 *   2. Search rentals in the same locality.
 *
 * Returns the target's locality + the rental cards Compass surfaces.
 * Honest-by-default: when no rentals come back, `rentals: []` with the
 * target context preserved so callers can decide whether to widen.
 */

export function registerComparableRentalsTools(
  server: McpServer,
  client: CompassClient
): void {
  server.registerTool(
    'compass_get_comparable_rentals',
    {
      title: 'List nearby rental listings for a Compass property',
      description:
        "Surface nearby rental listings for a Compass property — useful for evaluating STR (short-term-rental) viability in vacation markets. Lifts the target's city/state/zip from the homedetails page, then searches Compass's `type-rental/` filter in the same locality and returns each rental's address, monthly price (in `price_formatted`), beds/baths, sqft, and the Compass URL. Honest-by-default: when no rentals come back, `rentals: []` with the target locality preserved so the caller can decide to widen. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'List nearby rental listings for a Compass property',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        url: z
          .string()
          .optional()
          .describe(
            'Compass homedetails URL or path of the target property (preferred).'
          ),
        listing_id_sha: z
          .string()
          .optional()
          .describe(
            'Compass listing identifier. Sufficient on its own — the slug is resolved internally.'
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max rental candidates to return. Default 20.'),
      },
    },
    async ({ url, listing_id_sha, limit }) => {
      const { listing } = await fetchListingRecord(client, {
        url,
        listing_id_sha,
      });
      const loc = listing.location ?? {};
      // Prefer ZIP for narrow scoping; fall back to "city state".
      const locationSeed =
        loc.zipCode ??
        [loc.city, loc.state].filter(Boolean).join(', ') ??
        loc.prettyAddress ??
        '';
      if (!locationSeed) {
        return textResult({
          target: {
            listing_id_sha: listing.listingIdSHA,
            city: loc.city,
            state: loc.state,
            zip: loc.zipCode,
          },
          count: 0,
          rentals: [],
          warning:
            'target property had no locality data — cannot search for rental comparables',
        });
      }
      const path = buildSearchPath({
        location: locationSeed,
        home_type: 'rental',
      });
      const html = await client.fetchHtml(path);
      const uc = extractUc(html);
      const lol = uc ? findLolResults(uc) : null;
      const raw = lol?.data ?? [];
      const rentals = raw
        .map(formatHome)
        .filter((h): h is FormattedHome => h !== null)
        // Drop the target itself if it happens to appear in the rental
        // search (it shouldn't for for-sale targets, but a rental
        // target would).
        .filter((h) => h.listing_id_sha !== listing.listingIdSHA)
        .slice(0, limit ?? 20);
      return textResult({
        target: {
          listing_id_sha: listing.listingIdSHA,
          city: loc.city,
          state: loc.state,
          zip: loc.zipCode,
        },
        search_path: path,
        count: rentals.length,
        rentals,
      });
    }
  );
}
