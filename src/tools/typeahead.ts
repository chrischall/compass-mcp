/**
 * Compass's structured address typeahead — the `omnisuggest`
 * autocomplete API behind the site's search box.
 *
 * Issue #78 / #79. compass.com runs AWS WAF; the SSR free-text paths the
 * resolver historically depended on (`/homes-for-sale/?q=…`,
 * `/search/?q=…`) return 403 to the fetchproxy bridge, so they surface
 * zero candidates and the resolver reports a false "no listing matched"
 * for listings Compass actually has. The live site resolves addresses
 * through this structured endpoint instead, which is NOT WAF-walled.
 *
 * Captured live 2026-05-28 against a signed-in session:
 *
 *   POST /api/v3/omnisuggest/autocomplete
 *   Content-Type: application/json
 *   { "q": "158 Raven Blvd Lake Lure NC", "sources": [0] }
 *
 *   → 200 application/json
 *   {
 *     "categories": [
 *       { "name": 1, "label": "Addresses", "items": [
 *         { "text": "158 Raven Blvd", "subText": "Lake Lure, NC",
 *           "redirectUrl": "/listing/2029026490125049409/view",
 *           "source": 0, "id": "2029026490125049409",
 *           "ucGeoId": "charlotte", "info": {} }
 *       ] }
 *     ],
 *     "success": true, "rankerVersion": "v5.0"
 *   }
 *
 * The `id` IS the listing `listingIdSHA` — it matches the `_lid/` URL
 * segment on the public homedetails page
 * (`/homedetails/…/2029026490125049409_lid/`). `category.name === 1` is
 * the "Addresses" category; `sources: [0]` restricts the query to the
 * Addresses source so non-address suggestions (agents, schools, cities)
 * don't crowd out the street-address candidates we verify against.
 */

import type { ByAddressInput } from './by-address.js';
import { buildAddressQuery } from './by-address.js';

/** The structured address-suggest endpoint (POST, JSON). */
export const OMNISUGGEST_AUTOCOMPLETE_PATH =
  '/api/v3/omnisuggest/autocomplete';

/**
 * Omnisuggest "Addresses" category id. Compass tags each suggestion
 * category with a numeric `name`; `1` is the street-address category.
 */
const ADDRESSES_CATEGORY = 1;

/**
 * Omnisuggest source id for street addresses. Passing `sources: [0]`
 * narrows the autocomplete to address suggestions only.
 */
const ADDRESSES_SOURCE = 0;

/** A single address suggestion from the omnisuggest response. */
export interface OmnisuggestItem {
  /** Street-line text, e.g. "158 Raven Blvd" or "155 Quail Cove Blvd, Unit 1601". */
  text?: string;
  /** Locality text, e.g. "Lake Lure, NC". */
  subText?: string;
  /** Relative `/listing/<id>/view` link (server resolves to the listing). */
  redirectUrl?: string;
  source?: number;
  /** The listing `listingIdSHA` — matches the `_lid/` URL segment. */
  id?: string;
  ucGeoId?: string;
  info?: Record<string, unknown>;
}

interface OmnisuggestCategory {
  name?: number;
  label?: string;
  items?: OmnisuggestItem[];
}

export interface OmnisuggestResponse {
  categories?: OmnisuggestCategory[];
  success?: boolean;
  rankerVersion?: string;
  [k: string]: unknown;
}

/** Request body for the autocomplete POST. */
export interface AutocompleteBody {
  q: string;
  sources: number[];
}

/**
 * Build the autocomplete request body. We send the same joined
 * address string the SSR `?q=` rung used (`buildAddressQuery`), so the
 * structured rung sees the full street + locality the caller supplied,
 * and restrict to the Addresses source.
 */
export function buildAutocompleteBody(input: ByAddressInput): AutocompleteBody {
  return { q: buildAddressQuery(input), sources: [ADDRESSES_SOURCE] };
}

/**
 * Pull the street-address suggestions out of an omnisuggest response.
 * Returns only items carrying an `id` (the `listingIdSHA`); items
 * without one can't be turned into a listing URL.
 */
export function extractAddressCandidates(
  resp: OmnisuggestResponse | null | undefined
): OmnisuggestItem[] {
  const categories = resp?.categories ?? [];
  const addresses = categories.find((c) => c?.name === ADDRESSES_CATEGORY);
  const items = addresses?.items ?? [];
  return items.filter((i): i is OmnisuggestItem => Boolean(i?.id));
}
