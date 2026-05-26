import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CompassClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractUc } from '../page-state.js';
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
 * Graceful degradation: when no listing matches, the tool returns
 * `{ resolved: false, error: "no listing found" }` rather than
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
 * Extract the `pid` from a Compass `/listing/<slug>/<pid>_pid/` (or
 * `/homedetails/<slug>/<pid>_pid/`) path. Returns undefined for any
 * other URL shape — including the sha-flavored `_lid/` form.
 */
export function extractPidFromNavigationPageLink(
  link: string | undefined
): string | undefined {
  if (!link) return undefined;
  const m = /\/([A-Za-z0-9]+)_pid\/?$/.exec(link);
  return m ? m[1] : undefined;
}

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
        "Resolve a free-text street address to a Compass listing's canonical URL and identifiers in one call. Fires a single `/homes-for-sale/?q=<address>` site search, takes the top result, and returns `{ url, listing_id_sha, pid, address, resolved }`. The `url` is the stable `_pid/` form when Compass returns a `navigationPageLink` (preferred for trackers/bookmarks — sha URLs go stale on relisting), falling back to the `_lid/` form otherwise. " +
        'When no listing matches, returns `{ resolved: false, error: "no listing found" }` rather than throwing — supports graceful degradation by an umbrella caller that fans out across multiple per-site resolvers. Read-only; safe to call repeatedly.',
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
      const top = (lol?.data ?? []).find((e) => e?.listing?.listingIdSHA);
      const listing = top?.listing;
      if (!listing) {
        const result: ByAddressUnresolved = {
          resolved: false,
          error: 'no listing found',
          address: addressLine,
        };
        return textResult(result);
      }
      const pid = extractPidFromNavigationPageLink(listing.navigationPageLink);
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
