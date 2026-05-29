import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
} from '@fetchproxy/server';
import type { CompassClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractUc } from '../page-state.js';
import { extractPidFromUrl, locationToSlug } from '../url.js';
import { findLolResults } from './search.js';
import {
  OMNISUGGEST_AUTOCOMPLETE_PATH,
  buildAutocompleteBody,
  extractAddressCandidates,
  type OmnisuggestResponse,
} from './typeahead.js';

/**
 * `compass_get_by_address` — resolve a free-text street address to the
 * canonical Compass listing identifiers (URL, listing_id_sha, pid).
 *
 * Three-rung walker (issues #71, #78/#79). The shared
 * `resolveOneAddress` helper — also used by `compass_resolve_addresses`
 * per #68 parity — fires rungs in order:
 *
 *   0. typeahead — POST `/api/v3/omnisuggest/autocomplete` with the
 *      address as structured/joined `q` (issue #78/#79). This is the
 *      PRIMARY rung: compass.com runs AWS WAF and the SSR free-text
 *      paths the legacy rungs depend on return 403 to the bridge, so
 *      they surface zero candidates and the resolver used to report a
 *      false "no listing matched" for listings Compass actually has.
 *      The structured endpoint is not WAF-walled. Candidates carry an
 *      `id` (the `listingIdSHA`) plus a `text`/`subText` address that
 *      the #45 whole-token verifier checks. Tag `matched_via:
 *      "typeahead"`. Throws/empties fall through to the SSR rungs.
 *   1. freetext — `/homes-for-sale/?q=<query>` SSR. If the top
 *      candidate's subtitle-encoded address verifies against the query,
 *      lift its `listingIdSHA` + `pageLink` + `navigationPageLink`
 *      and tag `matched_via: "freetext"`. WAF-blocked today; kept as
 *      fallback in case it recovers.
 *   2. search_fallback — `/homes-for-sale/<locality-slug>/` SSR (first
 *      page only — `/page-N/` is dead, issue #87). Same address
 *      verifier. Fires only when the caller supplied enough locality
 *      (city/state, ZIP, etc.) to anchor on. Tag `matched_via:
 *      "search_fallback"`. Round-3 zillow corpus showed this rung
 *      carries rural/locality-mismatched addresses that the freetext
 *      rung silently misses.
 *
 * Match verification (issue #45). Compass's search degrades into a
 * far-away top hit when the local market has no match — pre-fix the
 * tool was happily returning resolved:true for those hits (e.g.
 * "126 Sleeping Bear Ln, Lake Lure, NC 28746" silently resolving to a
 * Charlotte condo). Every candidate on BOTH rungs is validated against
 * the query (case + abbreviation normalization, then whole-token
 * equality); if none match the tool returns resolved:false rather than
 * leak the wrong URL.
 *
 * Graceful degradation: when neither rung matches, the tool returns
 * `{ resolved: false, error: "no listing matched" }` rather than
 * throwing. The unified `get_property_canonical_links` umbrella tool
 * fans out across multiple per-site MCPs and needs each per-site
 * primitive to degrade quietly when its site has no match.
 *
 * URL stability: the `_pid/` URL (from `navigationPageLink`) is
 * preferred for stable references — sha URLs go stale on relisting
 * (see issue #27).
 */

export interface ByAddressInput {
  address: string;
  city?: string;
  state?: string;
  zip?: string;
}

/**
 * Compose the free-text query Compass's site search expects.
 * Whitespace is collapsed; missing optional fields are skipped.
 */
export function buildAddressQuery(input: ByAddressInput): string {
  const parts = [input.address, input.city, input.state, input.zip]
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .map((p) => p.trim().replace(/\s+/g, ' '));
  return parts.join(' ').trim();
}

/**
 * Format the input address as a human-readable single line.
 * Mirrors Compass's `location.prettyAddress` shape (`Street, City,
 * State Zip`) so callers can store or display a canonical form.
 */
function formatAddressLine(input: ByAddressInput): string {
  const head = input.address.trim().replace(/\s+/g, ' ');
  const tail = [input.city, input.state, input.zip]
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .map((p) => p.trim().replace(/\s+/g, ' '));
  if (tail.length === 0) return head;
  // "City, State Zip" — state+zip share a space; city separates with a comma.
  const cityPart = input.city ? input.city.trim() : '';
  const stateZip = [input.state, input.zip]
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .join(' ');
  const tailJoined = [cityPart, stateZip].filter((p) => p.length > 0).join(', ');
  return tailJoined ? `${head}, ${tailJoined}` : head;
}

/**
 * Common US street-type abbreviations, longest-form first so a "Lane"
 * rule doesn't trip on a shorter regex.
 */
const STREET_TYPE_CANON: Array<[RegExp, string]> = [
  [/\bboulevard\b/g, 'blvd'],
  [/\bstreet\b/g, 'st'],
  [/\bavenue\b/g, 'ave'],
  [/\bdrive\b/g, 'dr'],
  [/\broad\b/g, 'rd'],
  [/\bcourt\b/g, 'ct'],
  [/\bplace\b/g, 'pl'],
  [/\blane\b/g, 'ln'],
  [/\bcircle\b/g, 'cir'],
  [/\bterrace\b/g, 'ter'],
  [/\bhighway\b/g, 'hwy'],
  [/\bparkway\b/g, 'pkwy'],
  [/\bsuite\b/g, 'ste'],
];

/**
 * Normalize an address for substring comparison: lowercase, strip
 * punctuation, collapse whitespace, fold common street-type aliases.
 * Exported for direct unit-testing.
 */
export function normalizeAddressForMatch(s: string | undefined): string {
  if (!s) return '';
  let out = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.,#\/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [re, repl] of STREET_TYPE_CANON) out = out.replace(re, repl);
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Decide whether the candidate's address string actually matches the
 * caller's query. The candidate must contain every normalized token
 * from the query.address (street line), AND at least one numeric token
 * must be present (guards against matching on city/state words alone).
 * When the caller also supplied `city`/`state`/`zip`, those count as
 * positive signal but don't have to all appear — Compass's card
 * subtitles often drop the ZIP, and some listings drop the state.
 *
 * Exported for direct unit-testing of the match policy.
 */
export function addressMatchesQuery(
  candidate: string | undefined,
  query: ByAddressInput
): boolean {
  const cand = normalizeAddressForMatch(candidate);
  if (!cand) return false;
  // Split candidate into whole tokens. We compare token-equality rather
  // than substring containment to avoid prefix collisions like "12"
  // matching inside "1234" or "Lee" matching inside "Leesburg" — the
  // very class of silent wrong-match this PR is closing (issue #45).
  const candTokenSet = new Set(cand.split(' ').filter((t) => t.length > 0));
  const streetTokens = normalizeAddressForMatch(query.address)
    .split(' ')
    .filter((t) => t.length > 0);
  if (streetTokens.length === 0) return false;
  // Require at least one numeric token in the street — a street name
  // alone ("Main St") matches too aggressively.
  if (!streetTokens.some((t) => /\d/.test(t))) return false;
  // Every street-line token must appear in the candidate as a whole
  // token.
  if (!streetTokens.every((t) => candTokenSet.has(t))) return false;
  // If a city is given and the candidate has more than just the street
  // (i.e. there are extra tokens), require the city to be present too —
  // this is the gate that rejects the Charlotte-condo case where the
  // street numbers happen to overlap.
  if (query.city) {
    const cityTokens = normalizeAddressForMatch(query.city)
      .split(' ')
      .filter((t) => t.length > 0);
    if (cityTokens.length > 0 && !cityTokens.every((t) => candTokenSet.has(t))) {
      return false;
    }
  }
  return true;
}

/**
 * Re-export of `extractPidFromUrl` under its original tool-local name
 * for back-compat with callers that imported it from this module before
 * it was promoted to `src/url.ts`.
 */
export { extractPidFromUrl as extractPidFromNavigationPageLink } from '../url.js';

/** Which rung produced a successful resolution. */
export type MatchedVia = 'typeahead' | 'freetext' | 'search_fallback';

interface ByAddressResolved {
  resolved: true;
  url: string;
  listing_id_sha?: string;
  pid?: string;
  address: string;
  matched_via: MatchedVia;
}

interface ByAddressUnresolved {
  resolved: false;
  error: string;
  address: string;
}

type ByAddressResult = ByAddressResolved | ByAddressUnresolved;

interface RawListingLike {
  listingIdSHA?: string;
  pageLink?: string;
  navigationPageLink?: string;
  subtitles?: string[];
}

/**
 * Build the slug-rung path from caller-supplied locality. Compass's
 * `/homes-for-sale/<slug>/` routing accepts city/state, ZIP, or a bare
 * state segment. Returns null when the caller gave us nothing to anchor
 * on — in that case we skip the fallback rather than search the whole
 * country.
 *
 * Locality preference:
 *   1. `city, state` (e.g. "Lake Lure, NC" → "lake-lure-nc")
 *   2. `zip`         (e.g. "28746"        → "28746")
 *   3. `city`        (e.g. "Lake Lure"    → "lake-lure")
 *
 * State-only inputs deliberately skip this rung — slugging to bare
 * `nc` would fan out 5 pages of state-wide SSR fetches, and the
 * verifier (`addressMatchesQuery`) gates its city/zip checks on
 * presence, so a state-only query reduces to street-token equality
 * against every house in the state. Too thin a guard. (Matches the
 * homes-mcp #50 fix that dropped both city-only and state-only as
 * too-broad.)
 *
 * The slug rung deliberately omits a price band — that's the follow-up
 * in #70.
 */
export function buildFallbackSlugPath(
  input: ByAddressInput
): string | null {
  const { city, state, zip } = input;
  let locality: string | null = null;
  if (city && state) locality = `${city}, ${state}`;
  else if (zip) locality = zip;
  else if (city) locality = city;
  if (!locality) return null;
  const slug = locationToSlug(locality);
  if (!slug) return null;
  return `/homes-for-sale/${slug}/`;
}

/**
 * Find the first candidate whose subtitle-encoded address actually
 * matches the caller's query. Returns null when none match. The
 * #45/#55 silent-wrong-match guard runs here, so both the freetext rung
 * AND the slug-fallback rung get the same whole-token equality check.
 */
function findMatchingListing(
  entries: Array<{ listing?: RawListingLike } | undefined>,
  input: ByAddressInput
): RawListingLike | null {
  for (const entry of entries) {
    const l = entry?.listing;
    if (!l?.listingIdSHA) continue;
    const subtitleAddress = (l.subtitles ?? []).join(', ');
    if (addressMatchesQuery(subtitleAddress, input)) return l;
  }
  return null;
}

async function fetchListings(
  client: CompassClient,
  path: string
): Promise<Array<{ listing?: RawListingLike }>> {
  const html = await client.fetchHtml(path);
  const uc = extractUc(html);
  const lol = uc ? findLolResults(uc) : null;
  return (lol?.data ?? []) as Array<{ listing?: RawListingLike }>;
}

/**
 * `fetchListings` that tolerates a *content* failure on an SSR rung
 * (issue #86). compass.com runs AWS WAF; the free-text `?q=` SSR path
 * 403s the bridge (and `client.fetchHtml` raises a 403 / sign-in
 * interstitial error). That must NOT abort the resolve — the
 * search-backed slug rung has far better recall and has to stay
 * reachable. So a content failure here degrades to an empty candidate
 * list (fall through), while a TRANSPORT fault (timeout / bridge-down,
 * #85) is re-thrown so it can be classified as a retryable status
 * rather than masked as "this rung found nothing".
 */
async function fetchListingsTolerant(
  client: CompassClient,
  path: string
): Promise<Array<{ listing?: RawListingLike }>> {
  try {
    return await fetchListings(client, path);
  } catch (e) {
    if (
      e instanceof FetchproxyTimeoutError ||
      e instanceof FetchproxyBridgeDownError
    ) {
      throw e;
    }
    // WAF 403 / sign-in interstitial / HTTP error / parse fault — treat
    // as "this rung surfaced nothing" and fall through to the next rung.
    return [];
  }
}

/**
 * Run the structured typeahead rung (issue #78/#79). POSTs the address
 * to Compass's omnisuggest autocomplete endpoint and shapes each
 * Addresses candidate into a `RawListingLike` so the shared
 * `findMatchingListing` verifier + `buildListingUrl` can consume it
 * unchanged. The candidate's `id` is the `listingIdSHA`; autocomplete
 * carries no `_pid/`, so we leave `navigationPageLink`/`pageLink` unset
 * and `buildListingUrl` falls back to the `_lid/` form.
 *
 * Returns null on a *content* failure (WAF 403, HTTP error, empty,
 * parse fault) so the caller falls through to the SSR rungs.
 *
 * Transport faults are different (issue #85). A `FetchproxyTimeoutError`
 * / `FetchproxyBridgeDownError` means we never got an answer from
 * Compass — collapsing that to "typeahead had nothing" (null → fall
 * through → SSR rungs that are WAF-walled → false "no listing matched")
 * is exactly the misclassification that produced the false "covers only
 * 4/60" conclusion. We re-throw those so `retryOnceOnTimeout` gets a
 * chance and, failing that, the per-row classifier surfaces a distinct
 * retryable `status: "timeout"` / `"bridge_down"` instead of a bare
 * `resolved: false`.
 */
async function fetchTypeaheadCandidates(
  client: CompassClient,
  input: ByAddressInput
): Promise<Array<{ listing?: RawListingLike }> | null> {
  try {
    const resp = await client.fetchJson<OmnisuggestResponse>(
      OMNISUGGEST_AUTOCOMPLETE_PATH,
      { method: 'POST', body: buildAutocompleteBody(input) }
    );
    const candidates = extractAddressCandidates(resp);
    if (candidates.length === 0) return null;
    return candidates.map((c) => ({
      listing: {
        listingIdSHA: c.id,
        // Combine text + subText into the subtitle array the verifier
        // reads (it joins them with ", ").
        subtitles: [c.text, c.subText].filter(
          (s): s is string => typeof s === 'string' && s.length > 0
        ),
      } satisfies RawListingLike,
    }));
  } catch (e) {
    // Transport faults must NOT be swallowed (#85) — a timeout/bridge-
    // down is "we never asked", not "Compass has nothing".
    if (
      e instanceof FetchproxyTimeoutError ||
      e instanceof FetchproxyBridgeDownError
    ) {
      throw e;
    }
    return null;
  }
}

/**
 * Shared rung walker used by both `compass_get_by_address` and
 * `compass_resolve_addresses`. Pins the parity contract from #68 —
 * both routes MUST go through this helper so the rung sequence,
 * match policy, and `matched_via` labeling can't drift.
 *
 * Rungs (in order):
 *   0. typeahead — POST `/api/v3/omnisuggest/autocomplete` (structured
 *      address) with `addressMatchesQuery` verify (#78/#79). PRIMARY.
 *   1. freetext — `/homes-for-sale/?q=<query>` with `addressMatchesQuery` verify
 *   2. search_fallback — `/homes-for-sale/<locality-slug>/` first page
 *      with the same verify (#71). `/page-N/` is dead (#87), so this
 *      rung fetches page 1 only.
 */
export async function resolveOneAddress(
  client: CompassClient,
  input: ByAddressInput
): Promise<
  | { resolved: true; listing: RawListingLike; matched_via: MatchedVia }
  | { resolved: false; error: string }
> {
  // Rung 0: structured typeahead (issue #78/#79) — the primary rung.
  // Routes around the AWS WAF that 403s the SSR ?q= path below.
  const typeaheadEntries = await fetchTypeaheadCandidates(client, input);
  if (typeaheadEntries) {
    const typeaheadMatch = findMatchingListing(typeaheadEntries, input);
    if (typeaheadMatch) {
      return {
        resolved: true,
        listing: typeaheadMatch,
        matched_via: 'typeahead',
      };
    }
  }

  // Rung 1: free-text ?q= search. WAF-walled in production (403) — a
  // content failure here must fall through to the high-recall slug rung
  // (#86), not abort the resolve. `fetchListingsTolerant` swallows the
  // WAF 403 / sign-in error but still propagates a transport timeout
  // (#85).
  const query = buildAddressQuery(input);
  const freetextPath = `/homes-for-sale/?q=${encodeURIComponent(query)}`;
  const freetextEntries = await fetchListingsTolerant(client, freetextPath);
  const freetextMatch = findMatchingListing(freetextEntries, input);
  if (freetextMatch) {
    return { resolved: true, listing: freetextMatch, matched_via: 'freetext' };
  }

  // Rung 2: slug-based search anchored on locality (#71). This is the
  // first-class, high-recall search rung (#86) — it must run even when
  // the free-text rung above 403s. Tolerant of content faults for the
  // same reason; transport faults still propagate (#85).
  //
  // Only the first SSR page is reachable (#87): `/page-N/` canonicalizes
  // back to page 1 and returns the identical `lolResults`, so walking
  // `page-2/`, `page-3/`, … just re-checks the same ~COMPASS_PAGE_SIZE
  // listings. We fetch page 1 once. Its ~41 listings give this rung its
  // recall; to find an address outside that page the caller must anchor
  // on a tighter locality (ZIP vs. city).
  const slugBasePath = buildFallbackSlugPath(input);
  if (slugBasePath) {
    const entries = await fetchListingsTolerant(client, slugBasePath);
    const matched = findMatchingListing(entries, input);
    if (matched) {
      return {
        resolved: true,
        listing: matched,
        matched_via: 'search_fallback',
      };
    }
  }

  return { resolved: false, error: 'no listing matched the address' };
}

/**
 * Translate a resolved listing into the canonical URL form. Prefers the
 * stable `_pid/` URL (issue #27) when present.
 */
export function buildListingUrl(listing: RawListingLike): string {
  if (listing.navigationPageLink) {
    return `https://www.compass.com${listing.navigationPageLink}`;
  }
  if (listing.pageLink) {
    return `https://www.compass.com${listing.pageLink}`;
  }
  return `https://www.compass.com/homedetails/${listing.listingIdSHA}_lid/`;
}

export function registerByAddressTools(
  server: McpServer,
  client: CompassClient
): void {
  server.registerTool(
    'compass_get_by_address',
    {
      title: 'Resolve a Compass listing by street address',
      description:
        "Resolve a free-text street address to a Compass listing's canonical URL and identifiers in one call. Walks three rungs: first the structured typeahead `POST /api/v3/omnisuggest/autocomplete` (the primary rung — Compass's address-suggest API, which routes around the AWS WAF that 403s the SSR free-text path, issues #78/#79), then `/homes-for-sale/?q=<address>` (the free-text rung) and — when those return no verified match — a slug-based search at `/homes-for-sale/<city-state-or-zip>/` (the search-fallback rung, issue #71). Each candidate is verified against the query (case + street-type abbreviation normalization, then whole-token equality, issue #45) before being accepted. Returns `{ url, listing_id_sha, pid, address, resolved, matched_via }` where `matched_via` is `\"typeahead\"`, `\"freetext\"`, or `\"search_fallback\"` so callers can see which rung found the match. When no rung matches, returns `{ resolved: false, error: \"no listing matched\" }` rather than leaking a wrong URL. The `url` is the stable `_pid/` form when Compass provides a `navigationPageLink` (preferred for trackers/bookmarks — sha URLs go stale on relisting), falling back to the `_lid/` form otherwise. Read-only; safe to call repeatedly.",
      annotations: {
        title: 'Resolve a Compass listing by street address',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        address: z
          .string()
          .min(1)
          .describe('Street address line, e.g. "126 Sleeping Bear Ln".'),
        city: z.string().optional().describe('e.g. "Lake Lure"'),
        state: z
          .string()
          .optional()
          .describe('Two-letter state abbreviation, e.g. "NC"'),
        zip: z.string().optional().describe('ZIP code, e.g. "28746"'),
      },
    },
    async (input) => {
      const addressLine = formatAddressLine(input);
      const outcome = await resolveOneAddress(client, input);
      if (!outcome.resolved) {
        const result: ByAddressUnresolved = {
          resolved: false,
          error: outcome.error,
          address: addressLine,
        };
        return textResult(result);
      }
      const { listing, matched_via } = outcome;
      const result: ByAddressResolved = {
        resolved: true,
        url: buildListingUrl(listing),
        listing_id_sha: listing.listingIdSHA,
        pid: extractPidFromUrl(listing.navigationPageLink),
        address: addressLine,
        matched_via,
      };
      return textResult(result);
    }
  );
}

export type { ByAddressResult };
