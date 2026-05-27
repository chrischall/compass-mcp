import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CompassClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractUc } from '../page-state.js';
import { extractPidFromUrl } from '../url.js';
import { findLolResults } from './search.js';

/**
 * `compass_get_by_address` — resolve a free-text street address to the
 * canonical Compass listing identifiers (URL, listing_id_sha, pid).
 *
 * Internally this fires a single `/homes-for-sale/?q=<query>` search,
 * takes the top result, and lifts its `listingIdSHA` + `pageLink`
 * (always present) and `navigationPageLink` (the `_pid/` form, when
 * present). The `_pid/` URL is preferred for stable references — sha
 * URLs go stale on relisting (see issue #27).
 *
 * Match verification (issue #45). Compass's `?q=...` search degrades
 * into a far-away top hit when the local market has no match — pre-fix
 * the tool was happily returning resolved:true for those hits (e.g.
 * "126 Sleeping Bear Ln, Lake Lure, NC 28746" silently resolving to a
 * Charlotte condo). Every candidate is now validated against the query
 * (case + abbreviation normalization, then substring/token check); if
 * no candidate matches the tool returns resolved:false rather than
 * leak the wrong URL.
 *
 * Graceful degradation: when no listing matches, the tool returns
 * `{ resolved: false, error: "no listing matched" }` rather than
 * throwing. The unified `get_property_canonical_links` umbrella tool
 * fans out across multiple per-site MCPs and needs each per-site
 * primitive to degrade quietly when its site has no match.
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
  const streetTokens = normalizeAddressForMatch(query.address)
    .split(' ')
    .filter((t) => t.length > 0);
  if (streetTokens.length === 0) return false;
  // Require at least one numeric token in the street — a street name
  // alone ("Main St") matches too aggressively.
  if (!streetTokens.some((t) => /\d/.test(t))) return false;
  // Every street-line token must appear in the candidate.
  if (!streetTokens.every((t) => cand.includes(t))) return false;
  // If a city is given and the candidate has more than just the street
  // (i.e. there are extra tokens), require the city to be present too —
  // this is the gate that rejects the Charlotte-condo case where the
  // street numbers happen to overlap.
  if (query.city) {
    const cityTokens = normalizeAddressForMatch(query.city)
      .split(' ')
      .filter((t) => t.length > 0);
    if (cityTokens.length > 0 && !cityTokens.every((t) => cand.includes(t))) {
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

interface ByAddressResolved {
  resolved: true;
  url: string;
  listing_id_sha?: string;
  pid?: string;
  address: string;
}

interface ByAddressUnresolved {
  resolved: false;
  error: string;
  address: string;
}

type ByAddressResult = ByAddressResolved | ByAddressUnresolved;

export function registerByAddressTools(
  server: McpServer,
  client: CompassClient
): void {
  server.registerTool(
    'compass_get_by_address',
    {
      title: 'Resolve a Compass listing by street address',
      description:
        "Resolve a free-text street address to a Compass listing's canonical URL and identifiers in one call. Fires a single `/homes-for-sale/?q=<address>` site search, takes the top candidate that ACTUALLY MATCHES the query address (case + street-type abbreviation normalization, then substring/token check), and returns `{ url, listing_id_sha, pid, address, resolved }`. When no candidate matches — including the failure mode where Compass returns a far-away top hit for a query its local market doesn't cover — returns `{ resolved: false, error: \"no listing matched\" }` rather than leaking the wrong URL. The `url` is the stable `_pid/` form when Compass provides a `navigationPageLink` (preferred for trackers/bookmarks — sha URLs go stale on relisting), falling back to the `_lid/` form otherwise. Read-only; safe to call repeatedly.",
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
      const query = buildAddressQuery(input);
      const addressLine = formatAddressLine(input);
      const searchPath = `/homes-for-sale/?q=${encodeURIComponent(query)}`;
      const html = await client.fetchHtml(searchPath);
      const uc = extractUc(html);
      const lol = uc ? findLolResults(uc) : null;
      const candidates = (lol?.data ?? []).filter(
        (e) => e?.listing?.listingIdSHA
      );
      // Walk candidates in returned order; pick the first whose address
      // verifies against the query. This is the silent-wrong-match
      // gate from issue #45.
      const matched = candidates.find((entry) => {
        const l = entry.listing!;
        const subtitleAddress = (l.subtitles ?? []).join(', ');
        return addressMatchesQuery(subtitleAddress, input);
      });
      const listing = matched?.listing;
      if (!listing) {
        const result: ByAddressUnresolved = {
          resolved: false,
          error: 'no listing matched the address',
          address: addressLine,
        };
        return textResult(result);
      }
      const pid = extractPidFromUrl(listing.navigationPageLink);
      // Prefer the stable _pid/ form when available; fall back to _lid/.
      const url = listing.navigationPageLink
        ? `https://www.compass.com${listing.navigationPageLink}`
        : listing.pageLink
          ? `https://www.compass.com${listing.pageLink}`
          : `https://www.compass.com/homedetails/${listing.listingIdSHA}_lid/`;
      const result: ByAddressResolved = {
        resolved: true,
        url,
        listing_id_sha: listing.listingIdSHA,
        pid,
        address: addressLine,
      };
      return textResult(result);
    }
  );
}

export type { ByAddressResult };
