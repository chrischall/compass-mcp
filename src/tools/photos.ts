import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CompassClient } from '../client.js';
import { textResult } from '../mcp.js';
import { fetchListingRecord, type RawListing } from './properties.js';

/**
 * Compass photo galleries live at `listing.media[]` on the homedetails
 * page. Each media item carries:
 *
 *   - category: number (0 = photo, other values for floorplans/etc.)
 *   - originalUrl: full-res image URL on the Compass CDN
 *   - thumbnailUrl: ~640x480 (or similar) thumbnail
 *   - width / height: source pixel dimensions
 *
 * Verified live 2026-05-24 — homedetails returned 38 media entries
 * for a single property.
 */

export interface RawMediaItem {
  category?: number;
  originalUrl?: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
}

export interface FormattedPhoto {
  url?: string;
  thumbnail_url?: string;
  width?: number;
  height?: number;
  /** Compass uses 0 for primary photos; other categories include floorplans. */
  category?: number;
}

export function formatPhoto(m: RawMediaItem): FormattedPhoto | null {
  if (!m.originalUrl && !m.thumbnailUrl) return null;
  const out: FormattedPhoto = {};
  if (m.originalUrl) out.url = m.originalUrl;
  if (m.thumbnailUrl) out.thumbnail_url = m.thumbnailUrl;
  if (typeof m.width === 'number') out.width = m.width;
  if (typeof m.height === 'number') out.height = m.height;
  if (typeof m.category === 'number') out.category = m.category;
  return out;
}

/**
 * Filter to only photo-category items (category 0) by default. Floorplans
 * and other media kinds are included when `include_all_categories: true`.
 */
function pickMedia(
  raw: RawMediaItem[],
  includeAll: boolean
): RawMediaItem[] {
  if (includeAll) return raw;
  return raw.filter((m) => m.category === undefined || m.category === 0);
}

interface ListingWithMedia extends RawListing {
  media?: RawMediaItem[];
}

export function registerPhotosTools(
  server: McpServer,
  client: CompassClient
): void {
  server.registerTool(
    'compass_get_property_photos',
    {
      title: 'Get Compass property photo gallery',
      description:
        "The full photo gallery for a Compass listing — every image in listing.media[]. Each entry returns the original CDN URL plus a thumbnail URL and pixel dimensions. Pass `url` — the full Compass homedetails URL or path (e.g. from a compass_search_properties result's `url` field). By default only photos (category 0) are returned; set `include_all_categories: true` to also include floorplans and other media. Returns `{ listing_id_sha, count, photos }`. `listing_id_sha` alone is NOT enough — Compass requires the address slug too and returns 410 Gone for the slug-less URL. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Get Compass property photo gallery',
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
        include_all_categories: z
          .boolean()
          .optional()
          .describe(
            'Include non-photo media (floorplans, etc.). Default false.'
          ),
      },
    },
    async ({ url, listing_id_sha, include_all_categories }) => {
      const { listing } = await fetchListingRecord(client, {
        url,
        listing_id_sha,
      });
      const media = (listing as ListingWithMedia).media ?? [];
      const raw = pickMedia(media, !!include_all_categories);
      const photos = raw
        .map(formatPhoto)
        .filter((p): p is FormattedPhoto => p !== null);
      return textResult({
        listing_id_sha: listing.listingIdSHA,
        url: listing.pageLink
          ? `https://www.compass.com${listing.pageLink}`
          : undefined,
        count: photos.length,
        photos,
      });
    }
  );
}
