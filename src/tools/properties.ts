import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CompassClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractInitialData, extractUc } from '../page-state.js';
import { extractPidFromUrl, urlToPath } from '../url.js';
import { findLolResults } from './search.js';
import {
  extractFeatures,
  loadCommunities,
  type ExtractedFeatures,
} from '../features.js';

/**
 * Compass homedetails: GET /homedetails/<slug>/<listingIdSHA>_lid/
 *
 * The page server-renders `__INITIAL_DATA__.props.listingRelation.listing`
 * with the full property record. The listing object carries location,
 * size, price, description, detailedInfo (amenities, schools), media[]
 * (photos — see tools/photos.ts), and events[] / history[] (price
 * events — see tools/history.ts).
 *
 * Verified live 2026-05-24 against
 *   /homedetails/162-04-12th-Rd-Queens-NY-11357/2109718971930079225_lid/
 */

export interface RawListingLocation {
  prettyAddress?: string;
  streetNumber?: string;
  street?: string;
  streetType?: string;
  neighborhood?: string;
  subNeighborhoods?: string[];
  city?: string;
  state?: string;
  zipCode?: string;
  county?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  geoId?: string;
}

export interface RawListingSize {
  bedrooms?: number;
  bathrooms?: number;
  fullBathrooms?: number;
  halfBathrooms?: number;
  totalBathrooms?: number;
  totalRooms?: number;
  squareFeet?: number;
  lotSizeInSquareFeet?: number;
  lotSizeDimensions?: number[];
  formattedLotSize?: string;
}

export interface RawListingPrice {
  formatted?: string;
  lastKnown?: number;
  lastAsking?: number;
  preClose?: number;
  lastPropertyClosePrice?: number;
  perSquareFoot?: number;
  monthlySalesCharges?: number;
  monthlySalesChargesInclTaxes?: number;
}

export interface RawSchool {
  name?: string;
  distance?: string;
  gradesOffered?: string;
  greatSchoolsRating?: number;
  types?: string[];
}

export interface RawDetailedInfo {
  amenities?: string[];
  schools?: RawSchool[];
  propertyType?: Record<string, unknown>;
  totalParkingSpaces?: number;
  view?: string;
  architecturalStyle?: string;
  garageSpaces?: number;
}

/** Subset of media used to type-check photo/history tools; full shapes live alongside their tools. */
export interface RawListingMediaItem {
  category?: number;
  originalUrl?: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
}

export interface RawListingHistoryEvent {
  feedListingId?: string;
  price?: number;
  status?: number;
  localizedStatus?: string;
  pageLink?: string;
  timestamp?: number;
  source?: {
    externalSourceId?: string;
    externalSourceName?: string;
    sourceDisplayName?: string;
  };
}

export interface RawListing {
  listingIdSHA?: string;
  compassPropertyId?: number;
  feedListingId?: string;
  listingType?: number;
  status?: number;
  localizedStatus?: string;
  mlsStatus?: string;
  parcelNumber?: string;
  isOffMLS?: boolean;
  pageLink?: string;
  propertyPageLink?: string;
  navigationPageLink?: string;
  canonicalPageLink?: string;
  description?: string;
  date?: {
    contract?: number;
    updated?: number;
    lastPropertyCloseDate?: number;
  };
  location?: RawListingLocation;
  size?: RawListingSize;
  price?: RawListingPrice;
  detailedInfo?: RawDetailedInfo;
  media?: RawListingMediaItem[];
  events?: RawListingHistoryEvent[];
  history?: RawListingHistoryEvent[];
}

export interface FormattedProperty {
  listing_id_sha?: string;
  /**
   * Compass's opaque short ID — present when the listing's
   * `navigationPageLink` is a `<slug>/<pid>_pid/` form. The `_pid/`
   * URL is **stable across re-listings**, while `_lid/` URLs are
   * content-addressed by sha and go stale when a property is
   * delisted/relisted. Prefer the pid for any long-lived reference
   * (trackers, sheets, bookmarks); use the sha to fetch the *current*
   * listing record.
   */
  pid?: string;
  compass_property_id?: number;
  url: string;
  property_url?: string;
  status?: number;
  localized_status?: string;
  mls_status?: string;
  is_off_mls?: boolean;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  neighborhood?: string;
  sub_neighborhoods?: string[];
  county?: string;
  latitude?: number;
  longitude?: number;
  price_formatted?: string;
  price?: number;
  last_asking?: number;
  price_per_sqft?: number;
  monthly_charges?: number;
  beds?: number;
  baths?: number;
  full_baths?: number;
  half_baths?: number;
  sqft?: number;
  lot_size_sqft?: number;
  lot_size_formatted?: string;
  rooms?: number;
  /**
   * Raw `listing.description` (Compass-side marketing copy). Omitted
   * by default — callers usually keyword-parse and discard it; the
   * server-side `extracted_features` block covers the common needs.
   * Pass `include_description: true` on the tool input to keep it.
   * (Issue #34.)
   */
  description?: string;
  /**
   * Structured keyword signals lifted from the raw description. Always
   * populated when the listing has any description text at all.
   * (Issue #35.)
   */
  extracted_features?: ExtractedFeatures;
  amenities?: string[];
  parcel_number?: string;
  architectural_style?: string;
  garage_spaces?: number;
  parking_spaces?: number;
  contract_date_unix_ms?: number;
  updated_date_unix_ms?: number;
  last_close_date_unix_ms?: number;
  last_close_price?: number;
  schools?: Array<{
    name?: string;
    distance?: string;
    grades?: string;
    great_schools_rating?: number;
    types?: string[];
  }>;
}

interface ListingRelation {
  listing?: RawListing;
}

interface InitialDataProps {
  listingRelation?: ListingRelation;
}

interface InitialData {
  props?: InitialDataProps;
}

/** Pull the listing record out of a parsed `__INITIAL_DATA__` blob. */
export function findListing(data: Record<string, unknown>): RawListing | null {
  const props = (data as InitialData).props;
  return props?.listingRelation?.listing ?? null;
}

/**
 * Resolve a homedetails path synchronously. Returns the path if a `url`
 * was supplied, `null` if a `listing_id_sha` was supplied alone (caller
 * should fall through to the async `resolvePathFromSha`), and throws if
 * neither was supplied.
 *
 * Compass routes homedetails by `/homedetails/<slug>/<sha>_lid/` — the
 * slug-less `/homedetails/<sha>_lid/` form returns 410 Gone — so a bare
 * sha cannot become a working path without an extra lookup. That lookup
 * is async (it hits Compass's search), so this function returns `null`
 * to defer; sync callers should use the async resolver instead.
 */
export function buildPath(args: {
  listing_id_sha?: string;
  url?: string;
}): string | null {
  if (args.url) return urlToPath(args.url);
  if (args.listing_id_sha) return null;
  throw new Error(
    'compass property tool: must provide either listing_id_sha or url'
  );
}

/**
 * Resolve a `listing_id_sha` to a full `/homedetails/<slug>/<sha>_lid/`
 * path by querying Compass's site search. Compass's free-text search
 * endpoint accepts a listing-id-sha as a `q=` parameter and surfaces
 * the matching listing in `lolResults.data[]` with its canonical
 * `pageLink`.
 *
 * Throws when no result matches — the error names the sha and points
 * the caller at the `url` field of a `compass_search_properties` result
 * as a manual fallback.
 */
export async function resolvePathFromSha(
  client: CompassClient,
  sha: string
): Promise<string> {
  const searchPath = `/homes-for-sale/?q=${encodeURIComponent(sha)}`;
  const html = await client.fetchHtml(searchPath);
  const uc = extractUc(html);
  const lol = uc ? findLolResults(uc) : null;
  const match = (lol?.data ?? []).find(
    (entry) => entry?.listing?.listingIdSHA === sha
  );
  const pageLink = match?.listing?.pageLink;
  if (!pageLink) {
    throw new Error(
      `Could not resolve listing_id_sha "${sha}" to a Compass URL via site search. ` +
        `Compass returns 410 Gone for the slug-less /homedetails/<sha>_lid/ form, ` +
        `and no /homes-for-sale/?q=<sha> result matched. If you have the address, ` +
        `pass the \`url\` field from a compass_search_properties result instead.`
    );
  }
  return urlToPath(pageLink);
}

/**
 * Fetch + parse a Compass listing record. Shared by `compass_get_property`,
 * `compass_get_property_photos`, `compass_get_price_history`, and
 * `compass_compare_properties`.
 *
 * When called with `listing_id_sha` alone, runs `resolvePathFromSha`
 * first to recover the canonical `/homedetails/<slug>/<sha>_lid/` path
 * via Compass site search, then fetches normally.
 */
export async function fetchListingRecord(
  client: CompassClient,
  args: { listing_id_sha?: string; url?: string }
): Promise<{ listing: RawListing; path: string }> {
  let path = buildPath(args);
  if (path === null) {
    // buildPath returned null → sha-only call. Resolve via search.
    path = await resolvePathFromSha(client, args.listing_id_sha as string);
  }
  const html = await client.fetchHtml(path);
  const data = extractInitialData(html);
  if (!data) {
    throw new Error(
      `Could not locate __INITIAL_DATA__ at ${path}. ` +
        `Compass may have changed their page structure, or the listing may be restricted.`
    );
  }
  const listing = findListing(data);
  if (!listing) {
    throw new Error(
      `__INITIAL_DATA__.props.listingRelation.listing missing at ${path}.`
    );
  }
  return { listing, path };
}

export interface FormatOptions {
  /**
   * Include the raw `description` in the output. Defaults to `false`
   * because callers usually only need the structured `extracted_features`
   * block (which is always populated when description text exists).
   * (Issue #34.)
   */
  includeDescription?: boolean;
}

export function format(
  listing: RawListing,
  opts: FormatOptions = {}
): FormattedProperty {
  const loc = listing.location ?? {};
  const size = listing.size ?? {};
  const price = listing.price ?? {};
  const dInfo = listing.detailedInfo ?? {};
  const dates = listing.date ?? {};
  const url = listing.pageLink
    ? listing.pageLink.startsWith('http')
      ? listing.pageLink
      : `https://www.compass.com${listing.pageLink}`
    : `https://www.compass.com/homedetails/${listing.listingIdSHA ?? ''}_lid/`;
  const propertyUrl = listing.navigationPageLink
    ? `https://www.compass.com${listing.navigationPageLink}`
    : undefined;
  const pid = extractPidFromUrl(listing.navigationPageLink);
  // Pre-compute extracted_features (cheap) whenever a description is
  // present, so callers can drop the raw prose. (Issue #35.) The raw
  // description itself is opt-in via FormatOptions.includeDescription
  // — see Issue #34 for the context-savings rationale.
  const extractedFeatures: ExtractedFeatures | undefined = listing.description
    ? extractFeatures(listing.description, loadCommunities())
    : undefined;
  return {
    listing_id_sha: listing.listingIdSHA,
    pid,
    compass_property_id: listing.compassPropertyId,
    url,
    property_url: propertyUrl,
    status: listing.status,
    localized_status: listing.localizedStatus,
    mls_status: listing.mlsStatus,
    is_off_mls: listing.isOffMLS,
    address: loc.prettyAddress,
    city: loc.city,
    state: loc.state,
    zip: loc.zipCode,
    neighborhood: loc.neighborhood,
    sub_neighborhoods: loc.subNeighborhoods,
    county: loc.county,
    latitude: loc.latitude,
    longitude: loc.longitude,
    price_formatted: price.formatted,
    price: price.lastKnown,
    last_asking: price.lastAsking,
    price_per_sqft: price.perSquareFoot,
    monthly_charges: price.monthlySalesChargesInclTaxes,
    beds: size.bedrooms,
    baths: size.totalBathrooms ?? size.bathrooms,
    full_baths: size.fullBathrooms,
    half_baths: size.halfBathrooms,
    sqft: size.squareFeet,
    lot_size_sqft: size.lotSizeInSquareFeet,
    lot_size_formatted: size.formattedLotSize,
    rooms: size.totalRooms,
    // description is opt-in via FormatOptions; extracted_features is
    // always present when there's any description text to pull from.
    description: opts.includeDescription ? listing.description : undefined,
    extracted_features: extractedFeatures,
    amenities: dInfo.amenities,
    parcel_number: listing.parcelNumber,
    architectural_style: dInfo.architecturalStyle,
    garage_spaces: dInfo.garageSpaces,
    parking_spaces: dInfo.totalParkingSpaces,
    contract_date_unix_ms: dates.contract,
    updated_date_unix_ms: dates.updated,
    last_close_date_unix_ms: dates.lastPropertyCloseDate,
    last_close_price: price.lastPropertyClosePrice,
    schools: dInfo.schools?.map((s) => ({
      name: s.name,
      distance: s.distance,
      grades: s.gradesOffered,
      great_schools_rating: s.greatSchoolsRating,
      types: s.types,
    })),
  };
}

export function registerPropertyTools(
  server: McpServer,
  client: CompassClient
): void {
  server.registerTool(
    'compass_get_property',
    {
      title: 'Get Compass property details',
      description:
        "Fetch a property's full Compass record. Pass either `url` (a full Compass homedetails URL or path from a compass_search_properties result) or `listing_id_sha` alone — when only the sha is supplied, the tool resolves the canonical /homedetails/<slug>/<sha>_lid/ path internally via Compass site search. Returns address, neighborhood, beds/baths, sqft, price + price-per-sqft, monthly charges, MLS status, amenities, schools, parcel number, and the canonical Compass URL. Also returns `extracted_features` (lake_front, hot_tub, basement, furnished, dock, community) keyword-parsed from the description.\n\n" +
        "DESCRIPTION HANDLING: The raw `description` (Compass marketing copy) is omitted by default — pass `include_description: true` to keep it. `extracted_features` is always populated and usually sufficient.\n\n" +
        "URL FORMS: Compass exposes two URL shapes for a listing. `_lid/` (content-addressed by `listing_id_sha`) — what this tool fetches and what `url` returns — is the form to use for reading the current listing record. `_pid/` (opaque short ID, in `property_url` and the surfaced `pid` field) is **stable across re-listings** and is the right choice for any long-lived reference (trackers, sheets, bookmarks); sha-based URLs go stale when a property is delisted and relisted. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Get Compass property details',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        url: z
          .string()
          .optional()
          .describe(
            'Compass homedetails URL or path (e.g. /homedetails/162-04-12th-Rd-Queens-NY-11357/2109718971930079225_lid/). One of `url` or `listing_id_sha` is required; pass `url` when you have it (no resolver fetch needed).'
          ),
        listing_id_sha: z
          .string()
          .optional()
          .describe(
            'Compass listing identifier (the SHA inside `<sha>_lid`). Sufficient on its own — the tool will resolve the address slug internally via Compass site search before fetching the homedetails page (one extra HTTP round-trip).'
          ),
        include_description: z
          .boolean()
          .optional()
          .describe(
            'Include the raw `description` (Compass marketing copy) in the response. Defaults to `false` — `extracted_features` is always populated and usually covers the common needs.'
          ),
      },
    },
    async ({ url, listing_id_sha, include_description }) => {
      const { listing } = await fetchListingRecord(client, {
        url,
        listing_id_sha,
      });
      return textResult(
        format(listing, { includeDescription: include_description })
      );
    }
  );
}
