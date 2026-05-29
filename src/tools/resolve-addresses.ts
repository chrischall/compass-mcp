import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  BRIDGE_CONCURRENCY,
  classifyRowError,
  mapWithConcurrency,
  retryOnceOnTimeout,
} from '@fetchproxy/server';
import type { CompassClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractPidFromUrl } from '../url.js';
import {
  buildAddressQuery,
  buildListingUrl,
  resolveOneAddress,
  type ByAddressInput,
  type MatchedVia,
} from './by-address.js';

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
 * Bulk/single parity (issue #67 + #71). The whole rung walker is
 * delegated to `resolveOneAddress` from `./by-address.js` — the SAME
 * helper the single `compass_get_by_address` tool uses — so the two
 * paths can't drift on rung sequence, match policy (`addressMatchesQuery`
 * whole-token equality, #45), or `matched_via` labeling (#71). The
 * bulk path historically carried a local copy that used substring
 * containment and silently leaked prefix-collision wrong matches.
 */

export const RESOLVE_ADDRESSES_MAX = 100;

interface ResolvedRow {
  resolved: true;
  url: string;
  property_url?: string;
  listing_id_sha: string;
  pid?: string;
  address: string;
  matched_via: MatchedVia;
}

interface UnresolvedRow {
  resolved: false;
  error: string;
  query: string;
}

/**
 * Transport-fault row (issue #85). A cold-bridge typeahead/SSR timeout
 * or an unreachable bridge means we never got an answer from Compass —
 * this is categorically NOT a genuine no-match. We surface a distinct,
 * retryable `status` so a caller never reads a timeout as "Compass has
 * no listing here" (the false "covers only 4/60" conclusion). `resolved`
 * stays `false` for back-compat, but the presence of `status` is the
 * signal that the row is retryable, not a clean miss.
 */
interface TransportFaultRow {
  resolved: false;
  status: 'timeout' | 'bridge_down';
  retryable: true;
  error: string;
  query: string;
}

type RowResult = ResolvedRow | UnresolvedRow | TransportFaultRow;

async function resolveOne(
  client: CompassClient,
  input: ByAddressInput
): Promise<RowResult> {
  const query = buildAddressQuery(input);
  try {
    // `retryOnceOnTimeout` mirrors the bulk-get / compare paths
    // (`@fetchproxy/server` 0.9.x). A single timeout on a stale
    // rotating tab usually succeeds on the second attempt, so we buy
    // the retry back before the catch below would otherwise commit it
    // to `resolved: false`.
    const outcome = await retryOnceOnTimeout(() =>
      resolveOneAddress(client, input)
    );
    if (!outcome.resolved) {
      return { resolved: false, error: outcome.error, query };
    }
    const { listing, matched_via } = outcome;
    const subtitleAddress = (listing.subtitles ?? []).join(', ');
    const propertyUrl = listing.navigationPageLink
      ? `https://www.compass.com${listing.navigationPageLink}`
      : undefined;
    return {
      resolved: true,
      url: buildListingUrl(listing),
      property_url: propertyUrl,
      listing_id_sha: listing.listingIdSHA!,
      pid: extractPidFromUrl(listing.navigationPageLink),
      address: subtitleAddress || query,
      matched_via,
    };
  } catch (e) {
    // #85: distinguish a transport fault (timeout / bridge-down) from a
    // genuine no-match. `classifyRowError` (@fetchproxy/server) is the
    // cohort-standard discriminator — it runs AFTER `retryOnceOnTimeout`
    // has already burned its one-shot retry, so a `timeout` here means
    // the bridge stayed unresponsive across two attempts. Collapsing it
    // to `resolved: false` would make it indistinguishable from "Compass
    // has no listing here".
    const { kind, message } = classifyRowError(e);
    if (kind === 'timeout' || kind === 'bridge_down') {
      return { resolved: false, status: kind, retryable: true, error: message, query };
    }
    return { resolved: false, error: message, query };
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
        'either `{ resolved: true, url, listing_id_sha, pid, address, matched_via }`, `{ resolved: false, error, query }` for a genuine no-match, ' +
        'or — when the bridge timed out / was unreachable (issue #85) — `{ resolved: false, status: "timeout" | "bridge_down", retryable: true, error, query }`. ' +
        'A `status` row is NOT a miss: the lookup never completed, so retry it (a cold bridge usually succeeds on the second call) rather than concluding Compass has no listing. ' +
        "Each row walks the same three rungs as `compass_get_by_address` — first the structured typeahead `POST /api/v3/omnisuggest/autocomplete` (the primary rung that routes around the AWS WAF, issues #78/#79), then `/homes-for-sale/?q=<address>` (freetext), then `/homes-for-sale/<locality-slug>/` (search_fallback, issue #71) — and verifies candidates against the same whole-token address-match policy (#45). " +
        'The `matched_via` field on each resolved row indicates which rung found it. Compass\'s search degrades into far-away top hits when the local market has no match, and bulk amplifies the corruption ' +
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
      // Bounded fan-out — `@fetchproxy/server` 0.9.x BRIDGE_CONCURRENCY
      // (=6). The cohort comparison (#78) pinned this cap to keep the
      // bridge from timing out on resolver round-trips at scale. The
      // one-shot timeout retry sits inside `resolveOne` (before the
      // per-row catch swallows it into `resolved: false`).
      const rows = await mapWithConcurrency(
        addresses as ByAddressInput[],
        BRIDGE_CONCURRENCY,
        (a) => resolveOne(client, a)
      );
      return textResult({
        count: rows.length,
        rows,
      });
    }
  );
}
