import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CompassClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractUc } from '../page-state.js';
import { extractPidFromUrl, locationToSlug } from '../url.js';

/**
 * Compass's search results are server-rendered from
 *   GET /homes-for-sale/<location-slug>/[<filters>/]
 *
 * with state attached as `global.uc.sharedReactAppProps.initialResults`.
 * The interesting array is `lolResults.data[].listing` — each entry
 * carries the same denormalized facts you see on a card: address parts
 * (in `subtitles`), title (a formatted price string), media[],
 * subStats[] (beds/baths/sqft), pageLink, etc.
 *
 * Filters ride as URL path segments. Compass canonicalizes order:
 *
 *   /homes-for-sale/<loc>/<min-max>-bed/<min-max>-price/
 *
 * Verified live 2026-05-24 against
 *   /homes-for-sale/new-york-ny/2-3-bed/1500000-3500000-price/
 */

type HomeType = 'house' | 'condo' | 'townhouse' | 'multi_family' | 'land' | 'rental';

/** Compass URL-path segment slugs for home types. */
const HOME_TYPE_SLUG: Record<HomeType, string> = {
  house: 'type-house',
  condo: 'type-condo',
  townhouse: 'type-townhouse',
  multi_family: 'type-multi-family',
  land: 'type-land',
  rental: 'type-rental',
};

interface RawSubStat {
  title?: string;
  subtitle?: string;
  titleLabel?: string;
}

interface RawMediaItem {
  category?: number;
  originalUrl?: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
}

interface RawClusterSummary {
  bedrooms?: number;
  bathrooms?: number;
  priceRange?: number[];
  formattedLotSize?: string;
  savedListing?: boolean;
}

interface RawListing {
  listingIdSHA?: string;
  pageLink?: string;
  navigationPageLink?: string;
  title?: string;
  subtitles?: string[];
  status?: number;
  location?: { latitude?: number; longitude?: number };
  media?: RawMediaItem[];
  subStats?: RawSubStat[];
  clusterSummary?: RawClusterSummary;
}

export interface RawSearchEntry {
  listing?: RawListing;
  isInACollection?: boolean;
}

export interface FormattedHome {
  listing_id_sha: string;
  /**
   * Compass's opaque short ID — present when the listing carries a
   * `navigationPageLink` in `<slug>/<pid>_pid/` form. The `_pid/` URL
   * is **stable across re-listings**, while `_lid/` URLs are content-
   * addressed by sha and go stale when a property is delisted/relisted.
   * Prefer the pid for any long-lived reference (trackers, sheets,
   * bookmarks); use the sha to fetch the *current* listing record.
   */
  pid?: string;
  url: string;
  property_url?: string;
  address?: string;
  neighborhood?: string;
  price_formatted?: string;
  price_min?: number;
  price_max?: number;
  beds?: number;
  baths?: number;
  sqft?: number;
  lot_size?: string;
  latitude?: number;
  longitude?: number;
  primary_photo_url?: string;
  primary_thumbnail_url?: string;
  status?: number;
  saved?: boolean;
}

/** Parse a "3,400" or "3" subStat subtitle into a number. */
function parseStatNumber(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = parseFloat(s.replace(/,/g, ''));
  return Number.isNaN(n) ? undefined : n;
}

export function formatHome(entry: RawSearchEntry): FormattedHome | null {
  const l = entry.listing;
  if (!l?.listingIdSHA) return null;
  const subtitles = l.subtitles ?? [];
  // subtitles is typically ["<street address>", "<neighborhood>"]; some
  // listings use a different order, but the first is reliably the street.
  const street = subtitles[0];
  const neighborhood = subtitles[1];
  const stats: Record<string, number | undefined> = {};
  for (const s of l.subStats ?? []) {
    if (s.title === 'beds') stats.beds = parseStatNumber(s.subtitle);
    else if (s.title === 'baths') stats.baths = parseStatNumber(s.subtitle);
    else if (s.title === 'sqft') stats.sqft = parseStatNumber(s.subtitle);
  }
  const url = l.pageLink
    ? `https://www.compass.com${l.pageLink}`
    : `https://www.compass.com/homedetails/${l.listingIdSHA}_lid/`;
  const propertyUrl = l.navigationPageLink
    ? `https://www.compass.com${l.navigationPageLink}`
    : undefined;
  const cs = l.clusterSummary ?? {};
  const priceRange = cs.priceRange ?? [];
  const firstMedia = l.media?.[0];
  const pid = extractPidFromUrl(l.navigationPageLink);
  return {
    listing_id_sha: l.listingIdSHA,
    pid,
    url,
    property_url: propertyUrl,
    address: street,
    neighborhood,
    price_formatted: l.title,
    price_min: priceRange[0],
    price_max: priceRange.length > 1 ? priceRange[1] : undefined,
    beds: stats.beds ?? cs.bedrooms,
    baths: stats.baths ?? cs.bathrooms,
    sqft: stats.sqft,
    lot_size: cs.formattedLotSize,
    latitude: l.location?.latitude,
    longitude: l.location?.longitude,
    primary_photo_url: firstMedia?.originalUrl,
    primary_thumbnail_url: firstMedia?.thumbnailUrl,
    status: l.status,
    saved: cs.savedListing,
  };
}

export interface SearchInput {
  location: string;
  price_min?: number;
  price_max?: number;
  beds_min?: number;
  beds_max?: number;
  home_type?: HomeType;
  limit?: number;
  /** Zero-based offset into the result set. Only consumed by the tool layer. */
  offset?: number;
  /** 1-based Compass page index used for URL construction. */
  page?: number;
}

/**
 * Number of listings Compass server-renders into a single SSR
 * `lolResults.data[]` array — its `rawLolSearchQuery.num`. Verified live
 * 2026-05-29 against `/homes-for-sale/manhattan-ny/` (num: 41).
 *
 * This is the ONLY batch reachable through the SSR `fetchHtml` primitive:
 * the `/page-N/` path segment is dead (issue #87) — `/page-2/` etc.
 * canonicalize back to page 1 and return the identical data, so there is
 * no second SSR page to fetch. Used by `by-address.ts`'s slug rung as
 * the exhaustion threshold for its single reachable page.
 *
 * (The historical value was 5, an early under-count; the real page is
 * ~41, which is why a default limit-40 search fits in one SSR fetch.)
 */
export const COMPASS_PAGE_SIZE = 41;

/**
 * Build the `/homes-for-sale/<slug>/<filters>/[page-N/]` path for a
 * search. Order matches Compass's URL canonicalization: beds, then
 * price, then home type, then page. Returns a leading-slash path ready
 * for fetchHtml. `page=1` is left unsuffixed — Compass canonicalizes
 * page 1 to the bare URL and redirects `/page-1/` to it.
 */
export function buildSearchPath(input: SearchInput): string {
  const slug = locationToSlug(input.location);
  const segments: string[] = [];
  if (input.beds_min !== undefined || input.beds_max !== undefined) {
    const lo = input.beds_min ?? 0;
    const hi = input.beds_max ?? lo;
    segments.push(`${lo}-${hi}-bed`);
  }
  if (input.price_min !== undefined || input.price_max !== undefined) {
    const lo = input.price_min ?? 0;
    const hi = input.price_max ?? '';
    segments.push(`${lo}-${hi}-price`);
  }
  if (input.home_type) segments.push(HOME_TYPE_SLUG[input.home_type]);
  if (input.page !== undefined && input.page > 1) {
    segments.push(`page-${input.page}`);
  }
  const filters = segments.length > 0 ? segments.join('/') + '/' : '';
  return `/homes-for-sale/${slug}/${filters}`;
}

interface LolResults {
  totalItems?: number;
  data?: RawSearchEntry[];
}

interface InitialResults {
  lolResults?: LolResults;
  rawLolSearchQuery?: Record<string, unknown>;
}

interface SharedReactAppProps {
  initialResults?: InitialResults;
}

/**
 * Pull `sharedReactAppProps.initialResults.lolResults` out of a parsed
 * `uc` global. Returns null if the path is missing — Compass uses the
 * same `uc` shape on every SSR page, but only search pages populate
 * `lolResults`.
 */
export function findLolResults(
  uc: Record<string, unknown>
): LolResults | null {
  const srap = (uc.sharedReactAppProps ?? {}) as SharedReactAppProps;
  return srap.initialResults?.lolResults ?? null;
}

export function registerSearchTools(
  server: McpServer,
  client: CompassClient
): void {
  server.registerTool(
    'compass_search_properties',
    {
      title: 'Search Compass listings',
      description:
        "Search Compass listings by location (city, ZIP, neighborhood) and optional filters. Resolves free-text via slugification into Compass's URL routing, then fetches the SSR search-results page and extracts the embedded listings array. " +
        `Compass server-renders ~${COMPASS_PAGE_SIZE} listings into that page (its \`num\`), and \`total_items\` reports the full market count. ` +
        'PAGINATION (issue #87): Compass no longer paginates the SSR search via any URL — `/page-N/`, `?page=N`, and `?start=N` all canonicalize back to page 1 and return the identical listings, so only the first SSR page (~' +
        `${COMPASS_PAGE_SIZE} listings) is reachable through this primitive. \`offset\` is honored WITHIN that page, and \`next_offset\` is emitted only when more listings remain within it — it is never a false cursor that re-fetches page 1. ` +
        'TO REACH BEYOND THE FIRST PAGE, narrow with `price_min` / `price_max` / `beds_min`/`beds_max` to bucket the result set into <~' +
        `${COMPASS_PAGE_SIZE}-listing bands (price-banding), then search each band. ` +
        "Returns each matching listing's address, price, beds/baths, sqft, primary photo URL, lat/lng, the Compass homedetails URL (`_lid/` form, content-addressed by `listing_id_sha`), and the stable `_pid/` URL via `property_url` and the surfaced `pid` field. " +
        "USE `pid`/`_pid/` FOR LONG-LIVED REFERENCES (trackers, sheets, bookmarks) — sha-based `_lid/` URLs change when a property is delisted and relisted. Use the sha-based URL to fetch the current listing record. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Search Compass listings',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        location: z
          .string()
          .describe(
            'Free-text location: city, ZIP, neighborhood (e.g. "Brooklyn, NY", "94110", "Park Slope")'
          ),
        price_min: z.number().int().nonnegative().optional(),
        price_max: z.number().int().nonnegative().optional(),
        beds_min: z.number().int().nonnegative().optional(),
        beds_max: z.number().int().nonnegative().optional(),
        home_type: z
          .enum(['house', 'condo', 'townhouse', 'multi_family', 'land', 'rental'])
          .optional()
          .describe('Restrict to a single property type.'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Max listings to return (default 40). Only the first SSR page (~${COMPASS_PAGE_SIZE} listings) is reachable (#87), so a limit above that is capped by the page; use price/beds banding to reach more.`
          ),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            'Zero-based offset into the reachable first SSR page. Honored only within that page (#87); use the `next_offset` value from a previous response to continue within it. An offset at or beyond the page returns no results — narrow with price/beds bands to reach more. Default 0.'
          ),
      },
    },
    async (input) => {
      const limit = input.limit ?? 40;
      const offset = input.offset ?? 0;

      // PAGINATION HONESTY (issue #87). Compass no longer paginates the
      // SSR search via any URL: `/homes-for-sale/<slug>/page-N/`,
      // `?page=N`, and `?start=N` all canonicalize back to page 1 and
      // return the IDENTICAL `lolResults.data[]`. (Verified live: a
      // /page-2/ fetch carries `<link rel=canonical>` pointing at the
      // bare page-1 URL and the same first listing id.) Deeper pages now
      // load post-hydration via an XHR endpoint that is not reachable
      // through the SSR-only `fetchHtml` primitive this tool is built on.
      //
      // The only reachable batch is therefore the first SSR page, which
      // carries `num` (~41) listings. We fetch exactly that page, honor
      // an intra-page `offset`, and emit `next_offset` ONLY when more
      // listings remain WITHIN that single reachable page — never a
      // cursor that would just re-fetch page 1 (the old bug: a default
      // limit-40 call advertised `next_offset: 40`, and `offset: 40`
      // mapped to `page-9` yet returned the same first 40). To reach
      // results beyond the first SSR page, narrow with `price_min` /
      // `price_max` / `beds_min`/`beds_max` to bucket the result set.
      const path = buildSearchPath(input);
      const html = await client.fetchHtml(path);
      const uc = extractUc(html);
      if (!uc) {
        throw new Error(
          `compass_search_properties: could not extract the uc state object from ${path}. ` +
            `Compass may have changed their page bootstrap.`
        );
      }
      const lol = findLolResults(uc);
      const totalItems = lol?.totalItems;
      const formattedPage = (lol?.data ?? [])
        .map(formatHome)
        .filter((h): h is FormattedHome => h !== null);

      // Slice the single reachable page by the requested offset. An
      // offset at or beyond the page yields nothing — we can't reach
      // page 2.
      const results = formattedPage.slice(offset, offset + limit);
      const consumed = offset + results.length;

      // More remains ONLY if there are further listings within this same
      // reachable page (i.e. we truncated by `limit`, not by exhausting
      // the page). Once the first SSR page is exhausted we stop — never
      // advertise a cursor we cannot honor.
      const hasMore = consumed < formattedPage.length;

      return textResult({
        search_path: path,
        total_items: totalItems,
        count: results.length,
        offset,
        results,
        ...(hasMore ? { next_offset: consumed } : {}),
      });
    }
  );
}
