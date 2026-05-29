import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CompassClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractInitialData } from '../page-state.js';
import { extractAgentSlug, extractPidFromUrl, urlToPath } from '../url.js';
import { compassListingUrl } from './by-address.js';
import { loadCommunities } from '../features.js';
import {
  OMNISUGGEST_AUTOCOMPLETE_PATH,
  extractAddressCandidates,
  type AutocompleteBody,
  type OmnisuggestResponse,
} from './typeahead.js';
import {
  extractFeatures,
  type ExtractedFeatures,
  hoaToMonthlyUsd,
  sqftToAcres,
  cleanTaxAnnual,
  daysSince,
  priceDrop,
  buildHyperlinkFormula,
  collectAddressAlternates as collectAddressAlternatesCore,
} from '@chrischall/realty-core';

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

/**
 * Listing-side agent record. Compass surfaces these on the listing
 * page (the agent panel under the photo carousel). We lift the
 * primary (first) agent's id + name + brokerage onto the formatted
 * record. (Issue #52.)
 */
export interface RawListingAgent {
  id?: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  email?: string;
  phone?: string;
  /**
   * Agent's Compass profile href (`/agents/<slug>/` or the absolute form).
   * Surfaced as `listing_agent.profile_slug` / `profile_url` so a caller
   * can chain property → agent → their other listings via
   * `compass_get_agent_listings`. (Issue #52.)
   */
  profileUrl?: string;
}

/**
 * Annual property tax in Compass's payload. Some new-construction
 * listings carry sentinel placeholders (`0` or `1`) for not-yet-assessed
 * values — the formatter nulls those out so callers don't treat $1 as
 * a real tax bill. (Issue #38.)
 */
export interface RawAssociationFee {
  amount?: number;
  /**
   * `Monthly | Annually | Quarterly | SemiAnnually | Weekly`. Anything
   * else maps to `hoa_monthly_usd: null` with a stderr warn so unknown
   * shapes don't silently get treated as monthly. (Issue #36.)
   */
  frequency?: string;
}

export interface RawDetailedInfo {
  amenities?: string[];
  schools?: RawSchool[];
  propertyType?: Record<string, unknown>;
  totalParkingSpaces?: number;
  view?: string;
  architecturalStyle?: string;
  garageSpaces?: number;
  /** Annual property tax in USD. See sentinel-value cleanup, issue #38. */
  taxAnnualAmount?: number;
  /** HOA-fee bundle. Drives `hoa_monthly_usd` normalization. (Issue #36.) */
  associationFee?: RawAssociationFee;
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
  /**
   * Alternate addresses from MLS feeds — surfaced as `address_alternates`
   * when they disagree with `location.prettyAddress`. Real-world example:
   * "109 vs 169 Overlook Point Ln" between Compass and Canopy MLS for
   * the same listing. (Issue #44.)
   */
  mlsAlternateAddresses?: string[];
  /**
   * Listing agents in priority order — first is the primary. Surfaced
   * on `FormattedProperty.listing_agent`. (Issue #52.)
   */
  agents?: RawListingAgent[];
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
  /**
   * Sheets-paste-ready hyperlink formula pointing at the same listing.
   * Always present (mirrors `url`). Pasting into Google Sheets renders
   * as a clickable "Compass" link. Uses the stable `_pid/` URL form
   * when a `pid` is available; otherwise falls back to `_lid/`.
   * (Issue #43.)
   */
  portal_url_hyperlink: string;
  compass_property_id?: number;
  url: string;
  property_url?: string;
  status?: number;
  localized_status?: string;
  mls_status?: string;
  is_off_mls?: boolean;
  address?: string;
  /**
   * Alternate addresses surfaced by other MLS feeds when they disagree
   * with the primary `address`. Omitted when no alternates are present
   * (or when all alternates normalize to the primary). (Issue #44.)
   */
  address_alternates?: string[];
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
  /**
   * Derived from `events[]` — `previous_list_price - current_price`
   * when both are known. `null` when there's no prior list event.
   * (Issue #37.)
   */
  price_drop_amount?: number | null;
  /**
   * `(previous - current) / previous * 100`, rounded to 0.1. `null`
   * when either side is missing. (Issue #37.)
   */
  price_drop_percent?: number | null;
  /**
   * Days since the earliest "Listed" event timestamp. `null` when no
   * such event is present. (Issue #37.)
   */
  days_on_market?: number | null;
  /**
   * Annual property tax. Nulled out for the not-yet-assessed sentinel
   * (`< 10`) that Compass surfaces on some new-construction listings.
   * (Issue #38 / realty-mcp#1.)
   */
  tax_annual?: number | null;
  /**
   * `'not_yet_assessed'` when `tax_annual` was nulled out as the
   * new-construction placeholder, otherwise `null` (a real figure, or no
   * tax figure at all). Surfaced from the cohort `cleanTaxAnnual`
   * (realty-mcp#1) so callers can distinguish "placeholder" from "absent".
   */
  tax_status?: 'not_yet_assessed' | null;
  /**
   * HOA fee normalized to monthly USD, rounded to the nearest dollar.
   * `null` for unknown frequencies or when no fee is reported.
   * (Issue #36.)
   */
  hoa_monthly_usd?: number | null;
  beds?: number;
  baths?: number;
  full_baths?: number;
  half_baths?: number;
  sqft?: number;
  lot_size_sqft?: number;
  /**
   * `round(lot_size_sqft / 43560, 2)` — lot size in acres, the unit that
   * matters for rural/mountain/land listings. `null` (never `0`) when the
   * lot size is absent or `0` (condos / missing data). (Issue #82.)
   */
  lot_size_acres?: number | null;
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
  /**
   * Primary listing agent (first entry in the upstream `agents[]`).
   * Omitted when no agents are present. (Issue #52.) Includes the agent's
   * `profile_slug` / `profile_url` when the listing's agent record carries
   * a `/agents/<slug>/` href — feed that into `compass_get_agent_listings`
   * to pull the agent's *other* listings. The agent's listing history is
   * served by the agent-profile SSR blob (`window.__AGENT_PROFILE__` on
   * `/agents/<slug>/`), parsed by `tools/agent-listings.ts`.
   */
  listing_agent?: {
    id?: string;
    name?: string;
    brokerage?: string;
    /**
     * Agent's profile slug (the `<slug>` in `/agents/<slug>/`). Present
     * when the listing's agent record carries a profile href. Feed it
     * straight into `compass_get_agent_listings` to pull the agent's
     * other listings. (Issue #52.)
     */
    profile_slug?: string;
    /** Canonical `https://www.compass.com/agents/<slug>/` profile URL. (Issue #52.) */
    profile_url?: string;
  };
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
 * Resolve a `listing_id_sha` to a fetchable Compass homedetails path.
 *
 * Routes through the structured omnisuggest typeahead — the same
 * WAF-immune rung `compass_get_by_address` uses (issue #78/#79) — rather
 * than the SSR free-text `/homes-for-sale/?q=<sha>` path, which compass.com
 * 403s under AWS WAF (so sha-only `get_property` / `photos` / `history` /
 * `compare` / `bulk_get` were failing in prod whenever they hit it).
 *
 * The omnisuggest `id` IS the `listingIdSHA`, so we POST the sha as `q`,
 * find the candidate whose `id === sha`, and return its `redirectUrl`
 * (the `/listing/<sha>/view` path the server redirects to the canonical
 * homedetails page). The slug-less `/homedetails/<sha>_lid/` form 410s,
 * so the redirect path is the reliable way to reach the listing record
 * without already knowing the slug.
 *
 * Throws when no candidate matches — the error names the sha and points
 * the caller at the `url` field of a `compass_search_properties` result
 * as a manual fallback.
 */
export async function resolvePathFromSha(
  client: CompassClient,
  sha: string
): Promise<string> {
  const body: AutocompleteBody = { q: sha, sources: [0] };
  const resp = await client.fetchJson<OmnisuggestResponse>(
    OMNISUGGEST_AUTOCOMPLETE_PATH,
    { method: 'POST', body }
  );
  const candidates = extractAddressCandidates(resp);
  const match = candidates.find((c) => c.id === sha);
  const redirectUrl = match?.redirectUrl;
  if (!redirectUrl) {
    throw new Error(
      `Could not resolve listing_id_sha "${sha}" to a Compass URL via the omnisuggest typeahead. ` +
        `Compass returns 410 Gone for the slug-less /homedetails/<sha>_lid/ form, ` +
        `and no autocomplete candidate matched the sha. If you have the address, ` +
        `pass the \`url\` field from a compass_search_properties result instead.`
    );
  }
  return urlToPath(redirectUrl);
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

/**
 * Compose the Sheets-paste-ready `=HYPERLINK(...)` formula for a
 * Compass listing. Prefers the stable `_pid/` form (the
 * `navigationPageLink`) when present; falls back to the slugged
 * `pageLink` and then the slug-less `_lid/` form. Always returns a valid
 * formula string — callers shouldn't have to special-case the cell.
 * (Issue #43.)
 *
 * The target-URL selection is the compass-specific `compassListingUrl`
 * ladder (by-address.ts); the formula assembly delegates to the cohort
 * `buildHyperlinkFormula` (realty-mcp#1) with the `"Compass"` label.
 */
export function buildPortalUrlHyperlink(args: {
  navigationPageLink?: string;
  pageLink?: string;
  listingIdSHA?: string;
}): string {
  const target = compassListingUrl(args, { prefer: 'pid' });
  return buildHyperlinkFormula(target, 'Compass');
}

/**
 * Derive lot size in acres from a square-foot lot size (#82). Pairs with
 * the raw `lot_size_sqft` — acreage is the unit that matters for
 * rural/mountain/land listings (Compass surfaces both as e.g.
 * "1.05 AC / 45,738 SF" upstream).
 *
 * Thin adapter over the cohort `sqftToAcres` (realty-mcp#1): the
 * canonical helper's guard (`<= 0` → null, plus a tiny-lot
 * `< ~218 sqft → null` so a non-null result is always `> 0`) is
 * byte-behavior-identical to compass's prior inline `lotSizeAcres`, so
 * the swap is behavior-preserving. Kept as a named export because the
 * tool's call site + unit tests refer to `lotSizeAcres`.
 */
export function lotSizeAcres(
  lotSqFt: number | undefined | null
): number | null {
  return sqftToAcres(lotSqFt ?? undefined);
}

/**
 * Earliest "Listed" event from a Compass events[] array. We treat
 * `status === 1` AND/OR `localizedStatus === 'Listed'` as the listed
 * signal — Compass's numeric statuses include both 'Listed' and various
 * relisting / contract-fallthrough variants. Returns undefined when
 * nothing qualifies.
 */
function earliestListedEvent(
  events: RawListingHistoryEvent[] | undefined
): RawListingHistoryEvent | undefined {
  if (!events || events.length === 0) return undefined;
  const listed = events.filter(
    (e) =>
      e.status === 1 ||
      (e.localizedStatus && /^listed$/i.test(e.localizedStatus))
  );
  if (listed.length === 0) return undefined;
  return listed.reduce((earliest, e) =>
    (e.timestamp ?? Infinity) < (earliest.timestamp ?? Infinity) ? e : earliest
  );
}

/**
 * Collect alternate-address strings, excluding any that normalize to
 * the primary. Returns an empty array when nothing distinct surfaces.
 * (Issue #44.)
 *
 * Compass's alternate-address derivation (pull from
 * `raw.mlsAlternateAddresses`, trim, drop blanks) is portal-specific and
 * stays here; the normalize-and-dedupe-against-primary logic delegates to
 * the cohort `collectAddressAlternates` (realty-mcp#1), whose
 * `normalizeAddressForCompare` body was byte-identical to compass's prior
 * inline copy. This is distinct from the by-address verifier's binary
 * `addressMatchesQuery` gate, which is intentionally NOT hoisted.
 */
export function collectAddressAlternates(
  primary: string | undefined,
  raw: RawListing
): string[] {
  const candidates: string[] = [];
  for (const c of raw.mlsAlternateAddresses ?? []) {
    if (typeof c === 'string' && c.trim()) candidates.push(c.trim());
  }
  return collectAddressAlternatesCore(primary, candidates);
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
  // `url` preference order (issue #15): slugged `pageLink` (the canonical
  // `_lid/` form) → the resolvable `_pid/` `navigationPageLink` → and only
  // as a genuine last resort the slug-less `/homedetails/<sha>_lid/` form.
  // That last form 410s on compass.com, but a listing record that arrives
  // with neither `pageLink` nor `navigationPageLink` leaves nothing else
  // derivable without an extra search lookup — so it's a benign fallback,
  // not a fabricated scheme. The single URL ladder lives in
  // `compassListingUrl` (by-address.ts); this is the `pageLink`-first
  // (read-the-record) preference.
  const url = compassListingUrl(listing, { prefer: 'pageLink' });
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
  // Derived fields (issues #36–#38, #43, #44). Each helper is pure and
  // unit-tested; the return shape below stays declarative.
  const portalUrlHyperlink = buildPortalUrlHyperlink({
    navigationPageLink: listing.navigationPageLink,
    pageLink: listing.pageLink,
    listingIdSHA: listing.listingIdSHA,
  });
  const hoaMonthlyUsd = hoaToMonthlyUsd(
    dInfo.associationFee?.amount,
    dInfo.associationFee?.frequency
  );
  // tax_annual + tax_status: cleanTaxAnnual (realty-mcp#1) nulls the
  // not-yet-assessed sentinel and reports a `tax_status`. Behavior delta
  // vs the old inline `sanitizeTaxAnnual` (which nulled only `<= 1`): the
  // canonical sentinel threshold is `< 10`, so a 2–9 figure is now
  // flagged `not_yet_assessed` instead of passing through.
  const { tax_annual: taxAnnual, tax_status: taxStatus } = cleanTaxAnnual(
    dInfo.taxAnnualAmount
  );
  // price_drop_* + days_on_market: derive from the events[] trail.
  // priceDrop(previous, current) → {amount, percent} | null (realty-mcp#1).
  // Behavior delta vs the old inline: a price *rise* (or unchanged price)
  // now yields null rather than a negative `price_drop_amount` — correct
  // for a field named `price_drop_*`.
  const listedEvent = earliestListedEvent(listing.events);
  const drop = priceDrop(listedEvent?.price, price.lastKnown);
  const priceDropAmount: number | null = drop ? drop.amount : null;
  const priceDropPercent: number | null = drop ? drop.percent : null;
  const daysOnMarket = daysSince(listedEvent?.timestamp ?? null);
  const alternates = collectAddressAlternates(loc.prettyAddress, listing);
  // Primary listing agent (issue #52). Compass surfaces multiple agents
  // sometimes; the first entry is the listing agent.
  const primaryAgent = listing.agents?.[0];
  let listingAgent: FormattedProperty['listing_agent'];
  if (primaryAgent) {
    const composedName =
      [primaryAgent.firstName, primaryAgent.lastName].filter(Boolean).join(' ') ||
      undefined;
    listingAgent = {
      id: primaryAgent.id,
      name: primaryAgent.fullName ?? composedName,
      brokerage: primaryAgent.companyName,
    };
    // Profile slug/url for property → agent → their-listings chaining
    // (issue #52). `extractAgentSlug` throws on a non-`/agents/` href, so
    // guard with a try/catch: a malformed profileUrl just means we omit
    // the chain fields rather than failing the whole property fetch.
    if (primaryAgent.profileUrl) {
      try {
        const slug = extractAgentSlug(primaryAgent.profileUrl);
        listingAgent.profile_slug = slug;
        listingAgent.profile_url = `https://www.compass.com/agents/${slug}/`;
      } catch {
        // Non-/agents/ href — leave the chain fields undefined.
      }
    }
  }
  return {
    listing_id_sha: listing.listingIdSHA,
    pid,
    portal_url_hyperlink: portalUrlHyperlink,
    compass_property_id: listing.compassPropertyId,
    url,
    property_url: propertyUrl,
    status: listing.status,
    localized_status: listing.localizedStatus,
    mls_status: listing.mlsStatus,
    is_off_mls: listing.isOffMLS,
    address: loc.prettyAddress,
    address_alternates: alternates.length > 0 ? alternates : undefined,
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
    price_drop_amount: priceDropAmount,
    price_drop_percent: priceDropPercent,
    days_on_market: daysOnMarket,
    tax_annual: taxAnnual,
    tax_status: taxStatus,
    hoa_monthly_usd: hoaMonthlyUsd,
    beds: size.bedrooms,
    baths: size.totalBathrooms ?? size.bathrooms,
    full_baths: size.fullBathrooms,
    half_baths: size.halfBathrooms,
    sqft: size.squareFeet,
    lot_size_sqft: size.lotSizeInSquareFeet,
    lot_size_acres: lotSizeAcres(size.lotSizeInSquareFeet),
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
    listing_agent: listingAgent,
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
        "Fetch a property's full Compass record. Pass either `url` (a full Compass homedetails URL or path from a compass_search_properties result) or `listing_id_sha` alone — when only the sha is supplied, the tool resolves the canonical /homedetails/<slug>/<sha>_lid/ path internally via Compass site search. Returns address, neighborhood, beds/baths, sqft, lot size (`lot_size_sqft` plus the derived `lot_size_acres` = round(sqft / 43560, 2), null — never 0 — for condos / missing lots), price + price-per-sqft, monthly charges, MLS status, amenities, schools, parcel number, and the canonical Compass URL. Also returns `extracted_features` (lake_front, hot_tub, basement, furnished, dock, community) keyword-parsed from the description.\n\n" +
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
