import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CompassClient } from '../client.js';
import { textResult } from '../mcp.js';
import { extractAgentProfile } from '../page-state.js';
import { extractAgentSlug } from '../url.js';
import { format, type RawListing } from './properties.js';

/**
 * Compass agent profile: GET /agents/<slug>/
 *
 * Agent profile pages server-render their state into a
 * `window.__AGENT_PROFILE__ = {…}` blob (~1.4MB; no `__NEXT_DATA__` and no
 * `__INITIAL_DATA__`). Inside, the agent's listings live at:
 *
 *   - data.agentProfileProps.activeListingsProps.initialSales
 *       → an array of listing records with the SAME shape the homedetails
 *         `listingRelation.listing` carries (RawListing), so the existing
 *         `format()` normalizes them exactly like `compass_get_property`.
 *
 *   - data.agentProfileProps.closedDealsProps.initialSales
 *       → an array of `{ listing, aiHexID, listingCard }`; the listing
 *         record is under `.listing`.
 *
 * This is the data path #52 originally judged infeasible ("auth-walled
 * GraphQL / no SSR path"). That was wrong — the agent's listings ARE in the
 * SSR `__AGENT_PROFILE__` blob; we parse it the same way `page-state.ts`
 * pulls the other inline globals.
 */

/** Closed-deal entry — the listing record is nested under `.listing`. */
interface RawClosedDeal {
  listing?: RawListing;
  aiHexID?: string;
  listingCard?: unknown;
}

interface AgentProfileProps {
  activeListingsProps?: { initialSales?: RawListing[] };
  closedDealsProps?: { initialSales?: RawClosedDeal[] };
  // Agent identity is surfaced under the profile props. The exact key
  // varies by render; we probe a few realistic shapes in findAgentIdentity.
  agentInfo?: { name?: string; slug?: string; firstName?: string; lastName?: string };
  agent?: { name?: string; slug?: string; firstName?: string; lastName?: string };
  name?: string;
}

interface AgentProfileData {
  data?: { agentProfileProps?: AgentProfileProps };
}

function agentProfileProps(
  data: Record<string, unknown>
): AgentProfileProps | undefined {
  return (data as AgentProfileData).data?.agentProfileProps;
}

/**
 * Pull the active-listing records out of a parsed `__AGENT_PROFILE__`
 * blob: `data.agentProfileProps.activeListingsProps.initialSales`. Returns
 * `[]` (not null) when the branch is absent so callers can map directly.
 */
export function findActiveListings(data: Record<string, unknown>): RawListing[] {
  return agentProfileProps(data)?.activeListingsProps?.initialSales ?? [];
}

/**
 * Pull the closed-deal *listing records* out of a parsed `__AGENT_PROFILE__`
 * blob. Each `closedDealsProps.initialSales` entry wraps the listing under
 * `.listing`; we unwrap and drop any entry missing it. Returns `[]` when the
 * branch is absent.
 */
export function findClosedDeals(data: Record<string, unknown>): RawListing[] {
  const raw = agentProfileProps(data)?.closedDealsProps?.initialSales ?? [];
  return raw
    .map((d) => d?.listing)
    .filter((l): l is RawListing => !!l);
}

export interface AgentIdentity {
  name?: string;
  slug?: string;
}

/**
 * Lift the agent's name + slug from the profile blob, falling back to the
 * slug the caller requested when the blob omits identity (so the returned
 * `agent.slug` is always populated). The exact identity key in the real
 * blob is not load-bearing for the listings payload — we probe a couple of
 * realistic shapes and degrade gracefully.
 */
export function findAgentIdentity(
  data: Record<string, unknown>,
  requestedSlug: string
): AgentIdentity {
  const props = agentProfileProps(data);
  const info = props?.agentInfo ?? props?.agent;
  const name =
    info?.name ??
    ([info?.firstName, info?.lastName].filter(Boolean).join(' ') || undefined) ??
    props?.name;
  return {
    name,
    slug: info?.slug ?? requestedSlug,
  };
}

export function registerAgentListingsTools(
  server: McpServer,
  client: CompassClient
): void {
  server.registerTool(
    'compass_get_agent_listings',
    {
      title: "Get a Compass agent's listings",
      description:
        "Fetch the listings represented by a Compass agent from their profile page (/agents/<slug>/). Pass either `slug` (e.g. \"paige-mcguirk\") or `profile_url` (a full https://www.compass.com/agents/<slug>/ URL — both forms are accepted). Returns `{ agent: {name, slug}, active_listings: [...] }`, where each active listing carries the SAME normalized fields as compass_get_property (address, beds/baths, sqft, lot size, price + price-per-sqft, MLS status, the canonical Compass URL + stable pid, extracted_features, etc.).\n\n" +
        "CLOSED DEALS: the agent's sold/closed deals are opt-in — pass `include_closed: true` to add a `closed_deals` array (same normalized shape). Omitted by default to keep the payload lean.\n\n" +
        "CHAINING: the agent slug is surfaced on each property's `listing_agent.profile_slug` in compass_get_property results (compass_search_properties results don't carry the listing agent), so you can go property → agent → their other listings. Read-only; safe to call repeatedly.",
      annotations: {
        title: "Get a Compass agent's listings",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        slug: z
          .string()
          .optional()
          .describe(
            'Compass agent profile slug — the `<slug>` in /agents/<slug>/ (e.g. "paige-mcguirk"). One of `slug` or `profile_url` is required.'
          ),
        profile_url: z
          .string()
          .optional()
          .describe(
            'Full Compass agent profile URL (e.g. https://www.compass.com/agents/paige-mcguirk/) or an /agents/<slug>/ path. Accepted as an alternative to `slug`.'
          ),
        include_closed: z
          .boolean()
          .optional()
          .describe(
            "Include the agent's closed/sold deals as a `closed_deals` array. Defaults to `false` to keep the response lean."
          ),
      },
    },
    async ({ slug, profile_url, include_closed }) => {
      const ref = slug ?? profile_url;
      if (!ref) {
        throw new Error(
          'compass_get_agent_listings: must provide either `slug` or `profile_url`.'
        );
      }
      // extractAgentSlug normalizes both forms (and throws on a non-/agents/
      // URL or a malformed slug). The slug is already resolved + validated,
      // so build the path directly rather than re-running extractAgentSlug.
      const resolvedSlug = extractAgentSlug(ref);
      const path = `/agents/${resolvedSlug}/`;
      const html = await client.fetchHtml(path);
      const data = extractAgentProfile(html);
      if (!data) {
        throw new Error(
          `Could not locate window.__AGENT_PROFILE__ at ${path}. ` +
            'Compass may have changed their page structure, the agent slug may be wrong, ' +
            'or the page may be restricted.'
        );
      }
      const agent = findAgentIdentity(data, resolvedSlug);
      const activeListings = findActiveListings(data).map((l) => format(l));
      const payload: {
        agent: AgentIdentity;
        active_listings: ReturnType<typeof format>[];
        closed_deals?: ReturnType<typeof format>[];
      } = {
        agent,
        active_listings: activeListings,
      };
      if (include_closed) {
        payload.closed_deals = findClosedDeals(data).map((l) => format(l));
      }
      return textResult(payload);
    }
  );
}
