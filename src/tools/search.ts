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
 * Compass server-renders search results in fixed-size batches in the
 * SSR `lolResults.data[]` array. Subsequent pages are fetched via a
 * `/page-N/` path segment.
 *
 * The page size is a Compass server-side constant; we observe 5 per
 * page on `/homes-for-sale/...` SSR responses. Used to translate an
 * `offset` into a page index for `buildSearchPath`.
 */
export const COMPASS_PAGE_SIZE = 5;

/**
 * Hard cap on SSR page fetches per `compass_search_properties` call.
 * Documented in the tool description so callers know the upper bound
 * and can plan pagination. (Issue #47.)
 */
export const MAX_PAGES = 50;

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
        "Search Compass listings by location (city, ZIP, neighborhood) and optional filters. Resolves free-text via slugification into Compass's URL routing, then fetches the SSR search-results pages and extracts the embedded listings array. Compass returns " +
        `${COMPASS_PAGE_SIZE} listings per SSR page; this tool fetches additional pages as needed to satisfy \`limit\`, and accepts \`offset\` for cursor-style continuation. ` +
        'When more results remain, the response carries `next_offset` — pass it back as `offset` to page forward. ' +
        `RESULT-CAP HONESTY (issue #47): there is a hard safety cap of ${MAX_PAGES} SSR page fetches per call (≈${MAX_PAGES * COMPASS_PAGE_SIZE} listings). For markets with more results, page through with the \`offset\` cursor, or narrow with \`price_min\` / \`price_max\` / \`beds_min\`/\`beds_max\` to bucket the result set. ` +
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
            `Max listings to return (default 40). Compass server-renders ${COMPASS_PAGE_SIZE} listings per page, so honoring a larger limit fans out across multiple page fetches.`
          ),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            'Zero-based offset into the result set, for cursor-style pagination. Use the `next_offset` value from a previous response to fetch the next page. Default 0.'
          ),
      },
    },
    async (input) => {
      const limit = input.limit ?? 40;
      const offset = input.offset ?? 0;
      const startPage = Math.floor(offset / COMPASS_PAGE_SIZE) + 1;
      const intraPageSkip = offset % COMPASS_PAGE_SIZE;

      const collected: FormattedHome[] = [];
      let totalItems: number | undefined;
      let currentPage = startPage;
      let pagesFetched = 0;
      let shortPage = false;

      // Fetch successive Compass pages until we have `limit` formatted
      // results or the source runs out. Bound the loop by `totalItems`
      // when present and by MAX_PAGES (module constant) as a safety
      // net. The cap is documented in the tool description (#47).
      let pathLog = '';
      while (collected.length < limit && pagesFetched < MAX_PAGES) {
        const path = buildSearchPath({ ...input, page: currentPage });
        if (pagesFetched === 0) pathLog = path;
        const html = await client.fetchHtml(path);
        const uc = extractUc(html);
        if (!uc) {
          throw new Error(
            `compass_search_properties: could not extract the uc state object from ${path}. ` +
              `Compass may have changed their page bootstrap.`
          );
        }
        const lol = findLolResults(uc);
        if (totalItems === undefined) totalItems = lol?.totalItems;
        const raw = lol?.data ?? [];
        const formattedPage = raw
          .map(formatHome)
          .filter((h): h is FormattedHome => h !== null);

        // On the first page, skip the intra-page offset; subsequent
        // pages start clean.
        const sliceStart = pagesFetched === 0 ? intraPageSkip : 0;
        for (let i = sliceStart; i < formattedPage.length; i += 1) {
          if (collected.length >= limit) break;
          collected.push(formattedPage[i]);
        }

        pagesFetched += 1;
        // If Compass returned fewer than a full page, the result set is
        // exhausted — stop early even if we have not hit `limit`. Use
        // the *raw* page size: `formattedPage` has already had entries
        // without a `listingIdSHA` (cluster entries, "coming soon"
        // stubs, etc.) filtered out by `formatHome`, so its length can
        // drop below `COMPASS_PAGE_SIZE` even when Compass returned a
        // full page.
        if (raw.length < COMPASS_PAGE_SIZE) {
          shortPage = true;
          break;
        }
        // Likewise, if we know totalItems, stop once we have visited
        // them all.
        if (
          totalItems !== undefined &&
          offset + collected.length >= totalItems
        ) {
          break;
        }
        currentPage += 1;
      }

      const consumed = offset + collected.length;
      const hasMore =
        totalItems !== undefined
          ? consumed < totalItems
          : // Without totalItems, infer "more" from a saturated last page.
            // A short page already signals exhaustion, so suppress the
            // fallback in that case to avoid a misleading `next_offset`.
            !shortPage && collected.length >= limit;

      return textResult({
        search_path: pathLog,
        total_items: totalItems,
        count: collected.length,
        offset,
        results: collected,
        ...(hasMore ? { next_offset: consumed } : {}),
      });
    }
  );
}
