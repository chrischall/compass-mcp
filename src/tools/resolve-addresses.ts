import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CompassClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractUc } from '../page-state.js';
import { extractPidFromUrl } from '../url.js';
import {
  addressMatchesQuery,
  buildAddressQuery,
  type ByAddressInput,
} from './by-address.js';
import { findLolResults, formatHome, type FormattedHome } from './search.js';

/**
 * `compass_resolve_addresses` — bulk address-to-URL resolver.
 *
 * Issue #46. The cross-MCP report described a 60-address workflow that
 * took ~6 search calls + ~15 individual resolves + manual matching;
 * this collapses it to one round trip with concurrent server-side
 * fan-out.
 *
 * Each row is verified independently against the silent-wrong-match
 * policy from #45 — bulk amplifies the corruption surface area, so a
 * miss MUST return `resolved: false` with no URL leak. Per-row errors
 * (HTTP / parse failures) are captured separately so one bad input
 * doesn't fail the whole call.
 *
 * Bulk/single parity (issue #67). The address-match rung is delegated
 * to `addressMatchesQuery` from `./by-address.js` — the SAME helper the
 * single `compass_get_by_address` tool uses — so the two paths can't
 * drift on subtleties like substring vs. whole-token comparison. The
 * bulk path historically carried a local copy that used `cand.includes`
 * substring containment and silently leaked prefix-collision wrong
 * matches (e.g. "12 Oak St" resolving to "1234 Oak St").
 */

export const RESOLVE_ADDRESSES_MAX = 100;

interface ResolvedRow {
  resolved: true;
  url: string;
  property_url?: string;
  listing_id_sha: string;
  pid?: string;
  address: string;
}

interface UnresolvedRow {
  resolved: false;
  error: string;
  query: string;
}

type RowResult = ResolvedRow | UnresolvedRow;

async function resolveOne(
  client: CompassClient,
  input: ByAddressInput
): Promise<RowResult> {
  const query = buildAddressQuery(input);
  try {
    const path = `/homes-for-sale/?q=${encodeURIComponent(query)}`;
    const html = await client.fetchHtml(path);
    const uc = extractUc(html);
    const lol = uc ? findLolResults(uc) : null;
    const candidates = (lol?.data ?? [])
      .map(formatHome)
      .filter((h): h is FormattedHome => h !== null);
    const matched = candidates.find((h) => {
      // Use both subtitle parts as the candidate string (street + locality).
      // Single uses `(l.subtitles ?? []).join(', ')` — formatHome stashes
      // subtitle[0] in address and subtitle[1] in neighborhood, so this
      // recovers the same string.
      const candAddr = [h.address, h.neighborhood].filter(Boolean).join(', ');
      return addressMatchesQuery(candAddr, input);
    });
    if (!matched) {
      return {
        resolved: false,
        error: 'no listing matched the address',
        query,
      };
    }
    // formatHome stashes the pid-form URL in property_url; strip origin
    // to recover the path. Reverse out the path to extract the pid,
    // when present.
    const pid = extractPidFromUrl(
      matched.property_url?.replace('https://www.compass.com', '')
    );
    return {
      resolved: true,
      url: matched.url,
      property_url: matched.property_url,
      listing_id_sha: matched.listing_id_sha,
      pid,
      address: [matched.address, matched.neighborhood]
        .filter(Boolean)
        .join(', ') || query,
    };
  } catch (e) {
    return {
      resolved: false,
      error: e instanceof Error ? e.message : String(e),
      query,
    };
  }
}

export function registerResolveAddressesTools(
  server: McpServer,
  client: CompassClient
): void {
  server.registerTool(
    'compass_resolve_addresses',
    {
      title: 'Bulk-resolve Compass listings by street address',
      description:
        `Resolve up to ${RESOLVE_ADDRESSES_MAX} street addresses to Compass listing URLs in a single call. Returns one row per input, ` +
        'either `{ resolved: true, url, listing_id_sha, pid, address }` or `{ resolved: false, error, query }`. ' +
        "Each row is verified independently against the same address-match policy as `compass_get_by_address` — Compass's " +
        'search degrades into far-away top hits when the local market has no match, and bulk amplifies the corruption ' +
        'surface, so a miss returns `resolved: false` with no URL rather than leaking the wrong property. Calls fan out ' +
        'concurrently server-side. Read-only; safe to call repeatedly.',
      annotations: {
        title: 'Bulk-resolve Compass listings by street address',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        addresses: z
          .array(
            z
              .object({
                address: z
                  .string()
                  .min(1)
                  .describe('Street address line, e.g. "126 Sleeping Bear Ln".'),
                city: z.string().optional(),
                state: z.string().optional(),
                zip: z.string().optional(),
              })
              .passthrough()
          )
          .min(1)
          .max(RESOLVE_ADDRESSES_MAX)
          .describe(
            `Up to ${RESOLVE_ADDRESSES_MAX} address inputs. For higher counts, batch into multiple calls.`
          ),
      },
    },
    async ({ addresses }) => {
      const rows = await Promise.all(
        (addresses as ByAddressInput[]).map((a) => resolveOne(client, a))
      );
      return textResult({
        count: rows.length,
        rows,
      });
    }
  );
}
