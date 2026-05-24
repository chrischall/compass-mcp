import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CompassClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractInitialData } from '../page-state.js';
import { urlToPath } from '../url.js';

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
  description?: string;
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
 * Resolve a homedetails path. Accepts a listing-id-SHA or full URL.
 */
export function buildPath(args: {
  listing_id_sha?: string;
  url?: string;
}): string {
  if (args.url) return urlToPath(args.url);
  if (args.listing_id_sha) return `/homedetails/${args.listing_id_sha}_lid/`;
  throw new Error(
    'compass property tool: must provide either listing_id_sha or url'
  );
}

/**
 * Fetch + parse a Compass listing record. Shared by `compass_get_property`,
 * `compass_get_property_photos`, `compass_get_price_history`, and
 * `compass_compare_properties`.
 */
export async function fetchListingRecord(
  client: CompassClient,
  args: { listing_id_sha?: string; url?: string }
): Promise<{ listing: RawListing; path: string }> {
  const path = buildPath(args);
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

export function format(listing: RawListing): FormattedProperty {
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
  return {
    listing_id_sha: listing.listingIdSHA,
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
    description: listing.description,
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
        "Fetch a property's full Compass record. Provide either `url` (a full Compass homedetails URL or path) or `listing_id_sha` (the listing identifier). Returns address, neighborhood, beds/baths, sqft, price + price-per-sqft, monthly charges, MLS status, amenities, schools, parcel number, and the canonical Compass URL. Read-only; safe to call repeatedly.",
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
            'Compass homedetails URL or path (e.g. /homedetails/162-04-12th-Rd-Queens-NY-11357/2109718971930079225_lid/)'
          ),
        listing_id_sha: z
          .string()
          .optional()
          .describe('The Compass listing identifier (the `_lid` segment of the URL).'),
      },
    },
    async ({ url, listing_id_sha }) => {
      const { listing } = await fetchListingRecord(client, {
        url,
        listing_id_sha,
      });
      return textResult(format(listing));
    }
  );
}
