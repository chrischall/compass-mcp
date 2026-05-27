import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CompassClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractUc } from '../page-state.js';
import { findLolResults, formatHome, type FormattedHome } from './search.js';
import { locationToSlug } from '../url.js';

/**
 * Address-to-URL resolver for Compass.
 *
 * Compass has no first-party `/api/by-address` endpoint, so we drive
 * the public search page and verify each candidate's address matches
 * the query before returning `resolved: true`. The verification step
 * is non-negotiable — issue #45 documented a silent-wrong-match
 * regression where the tool would return resolved:true with the
 * top-of-results URL even when that URL pointed at a completely
 * unrelated property (a Charlotte condo for a Lake Lure NC query).
 *
 * Match policy:
 *   1. Normalize both sides (lowercase, drop punctuation, collapse
 *      whitespace, canonicalize common street-type abbreviations).
 *   2. Require the query's normalized form to appear as a substring of
 *      the candidate's normalized full address. This handles partial
 *      queries (street only) matching full-address candidates.
 *   3. If no candidate matches, return `resolved: false`.
 */

export interface ResolvedByAddress {
  resolved: true;
  url: string;
  property_url?: string;
  listing_id_sha: string;
  address: string;
  match_method: 'exact' | 'normalized';
}

export interface UnresolvedByAddress {
  resolved: false;
  error: string;
  query: string;
}

export type ByAddressResult = ResolvedByAddress | UnresolvedByAddress;

export interface ByAddressInput {
  address: string;
  city?: string;
  state?: string;
  zip?: string;
}

/** Join non-empty parts with ", ". */
export function buildAddressQuery(args: ByAddressInput): string {
  return [args.address, args.city, args.state, args.zip]
    .map((p) => (p ?? '').trim())
    .filter((p) => p.length > 0)
    .join(', ');
}

/**
 * Canonicalize common US street-type abbreviations to a single form.
 * Order matters — match longer forms first so "Lane" doesn't get
 * partially eaten by a shorter rule.
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
 */
export function normalizeAddressForMatch(s: string | undefined): string {
  if (!s) return '';
  let out = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    // Drop punctuation we don't care about for matching.
    .replace(/[.,#\/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [re, repl] of STREET_TYPE_CANON) out = out.replace(re, repl);
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Returns true when `candidate` is a plausible address-match for the
 * caller's `query`. The candidate (Compass's stored address) must
 * contain every normalized token from the query in order — really we
 * just substring-test the normalized query against the normalized
 * candidate.
 */
export function addressMatchesQuery(
  candidate: string | undefined,
  query: string
): boolean {
  const c = normalizeAddressForMatch(candidate);
  const q = normalizeAddressForMatch(query);
  if (!c || !q) return false;
  if (c === q) return true;
  if (c.includes(q)) return true;
  // Also accept the inverse: the user may have a fuller string than
  // what Compass surfaces in the card subtitles (e.g. ZIP). Fall back
  // to checking that every space-separated token of the query appears
  // in the candidate.
  const tokens = q.split(' ').filter((t) => t.length > 0);
  // Require ALL tokens to be present — and at least one of them must be
  // numeric (the street number), otherwise we'd match on city/state alone.
  if (tokens.length === 0) return false;
  const hasNumeric = tokens.some((t) => /\d/.test(t));
  if (!hasNumeric) return false;
  return tokens.every((t) => c.includes(t));
}

/**
 * Pick the candidate whose address matches the query, returning the
 * formatted home + the match method used.
 */
export function findMatch(
  candidates: FormattedHome[],
  query: string
): { home: FormattedHome; method: 'exact' | 'normalized' } | null {
  for (const h of candidates) {
    // Build the full address string Compass shows on the search card —
    // street (subtitles[0]) + neighborhood/city/zip line (subtitles[1]).
    // We mirror that as `address` (street) for the returned shape.
    const fullCandidate = [h.address, h.neighborhood].filter(Boolean).join(', ');
    if (!fullCandidate) continue;
    // "exact" reserved for byte-for-byte string equality; "normalized"
    // covers any address that matches only after lowercasing /
    // abbreviation folding.
    if (fullCandidate === query) {
      return { home: h, method: 'exact' };
    }
    if (addressMatchesQuery(fullCandidate, query)) {
      return { home: h, method: 'normalized' };
    }
  }
  return null;
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
        "Resolve a free-text street address (with optional city/state/zip) to a Compass homedetails URL. Drives the public `/homes-for-sale/<slug>/` search and verifies each candidate's address against the query before returning. Returns `{ resolved: true, url, listing_id_sha, address, match_method }` only when a candidate's address actually matches; otherwise returns `{ resolved: false, error, query }` — Compass has no first-party address-resolver API, so a search miss or a far-away top hit cannot be promoted to `resolved: true`. Read-only; safe to call repeatedly. Note: historically (pre-v0.7) this tool exhibited a silent-wrong-match bug — defensive callers should still spot-check the returned `address` field for sanity.",
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
      // Slug-search by city/state/zip when available — that's the
      // most reliable scoping. Fall back to the street address as a
      // last resort. Compass's slug router happily takes any of these.
      const locationSeed =
        [input.zip, input.city, input.state].filter(Boolean).join(', ') ||
        input.address;
      const path = `/homes-for-sale/${locationToSlug(locationSeed)}/`;
      const html = await client.fetchHtml(path);
      const uc = extractUc(html);
      const lol = uc ? findLolResults(uc) : null;
      const raw = lol?.data ?? [];
      const formatted = raw
        .map(formatHome)
        .filter((h): h is FormattedHome => h !== null);
      const match = findMatch(formatted, query);
      if (!match) {
        const result: UnresolvedByAddress = {
          resolved: false,
          error: 'no listing matched the address (search returned no candidate with a matching address — Compass has no first-party address resolver)',
          query,
        };
        return textResult(result);
      }
      const result: ResolvedByAddress = {
        resolved: true,
        url: match.home.url,
        property_url: match.home.property_url,
        listing_id_sha: match.home.listing_id_sha,
        address: [match.home.address, match.home.neighborhood]
          .filter(Boolean)
          .join(', ') || query,
        match_method: match.method,
      };
      return textResult(result);
    }
  );
}
