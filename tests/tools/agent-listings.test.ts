import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { CompassClient } from '../../src/client.js';
import {
  findActiveListings,
  findClosedDeals,
  findAgentIdentity,
  registerAgentListingsTools,
} from '../../src/tools/agent-listings.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as CompassClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

// A minimal `window.__AGENT_PROFILE__` blob shaped exactly like the real
// SSR structure (verified live against /agents/<slug>/):
//   data.agentProfileProps.activeListingsProps.initialSales  → RawListing[]
//   data.agentProfileProps.closedDealsProps.initialSales     → { listing, ... }[]
// The active-listing records share `RawListing`'s shape so the existing
// `format()` normalizes them like compass_get_property.
const ACTIVE_1 = {
  listingIdSHA: 'sha-active-1',
  compassPropertyId: 111,
  pageLink: '/homedetails/1-Active-Rd-Queens-NY-11357/sha-active-1_lid/',
  navigationPageLink: '/homedetails/1-Active-Rd-Queens-NY-11357/AAA111_pid/',
  status: 9,
  localizedStatus: 'Active',
  location: { prettyAddress: '1 Active Rd', city: 'Queens', state: 'NY', zipCode: '11357' },
  size: { bedrooms: 3, totalBathrooms: 2, squareFeet: 1800, lotSizeInSquareFeet: 45_738 },
  price: { formatted: '$1,200,000', lastKnown: 1_200_000 },
};
const ACTIVE_2 = {
  listingIdSHA: 'sha-active-2',
  compassPropertyId: 222,
  pageLink: '/homedetails/2-Active-Ave-Queens-NY-11357/sha-active-2_lid/',
  status: 9,
  localizedStatus: 'Active',
  location: { prettyAddress: '2 Active Ave', city: 'Queens', state: 'NY', zipCode: '11357' },
  size: { bedrooms: 2, totalBathrooms: 1, squareFeet: 1100 },
  price: { formatted: '$800,000', lastKnown: 800_000 },
};
const CLOSED_LISTING = {
  listingIdSHA: 'sha-closed-1',
  compassPropertyId: 333,
  pageLink: '/homedetails/3-Closed-Ln-Queens-NY-11357/sha-closed-1_lid/',
  status: 14,
  localizedStatus: 'Sold',
  location: { prettyAddress: '3 Closed Ln', city: 'Queens', state: 'NY', zipCode: '11357' },
  size: { bedrooms: 4, totalBathrooms: 3, squareFeet: 2400 },
  price: { formatted: '$2,000,000', lastKnown: 2_000_000 },
};

const agentProfileData = {
  data: {
    agentProfileProps: {
      // The agent identity surfaces under the profile props. We tolerate a
      // few realistic shapes; the fixture uses `agentInfo`.
      agentInfo: { name: 'Paige McGuirk', slug: 'paige-mcguirk' },
      activeListingsProps: { initialSales: [ACTIVE_1, ACTIVE_2] },
      closedDealsProps: {
        initialSales: [
          { listing: CLOSED_LISTING, aiHexID: 'hex-1', listingCard: {} },
        ],
      },
    },
  },
};

const agentProfileHtml = (data: unknown) =>
  `<html><body><script>window.__AGENT_PROFILE__ = ${JSON.stringify(
    data
  )};</script></body></html>`;

describe('findActiveListings', () => {
  it('pulls data.agentProfileProps.activeListingsProps.initialSales', () => {
    const sales = findActiveListings(agentProfileData);
    expect(sales).toHaveLength(2);
    expect(sales[0].listingIdSHA).toBe('sha-active-1');
    expect(sales[1].listingIdSHA).toBe('sha-active-2');
  });

  it('returns [] when the active-listings branch is missing', () => {
    expect(findActiveListings({ data: { agentProfileProps: {} } })).toEqual([]);
    expect(findActiveListings({})).toEqual([]);
  });
});

describe('findClosedDeals', () => {
  it('pulls the listing record out of each closed-deal entry (.listing)', () => {
    const closed = findClosedDeals(agentProfileData);
    expect(closed).toHaveLength(1);
    expect(closed[0].listingIdSHA).toBe('sha-closed-1');
  });

  it('returns [] when the closed-deals branch is missing', () => {
    expect(findClosedDeals({ data: { agentProfileProps: {} } })).toEqual([]);
    expect(findClosedDeals({})).toEqual([]);
  });
});

describe('findAgentIdentity', () => {
  it('lifts the agent name + slug from the profile blob', () => {
    expect(findAgentIdentity(agentProfileData, 'paige-mcguirk')).toEqual({
      name: 'Paige McGuirk',
      slug: 'paige-mcguirk',
    });
  });

  it('falls back to the requested slug when the blob omits identity', () => {
    const ident = findAgentIdentity(
      { data: { agentProfileProps: {} } },
      'some-agent'
    );
    expect(ident.slug).toBe('some-agent');
  });

  it('composes the name from firstName/lastName when `name` is absent', () => {
    const ident = findAgentIdentity(
      {
        data: {
          agentProfileProps: {
            agentInfo: { firstName: 'Paige', lastName: 'McGuirk', slug: 'paige-mcguirk' },
          },
        },
      },
      'paige-mcguirk'
    );
    expect(ident).toEqual({ name: 'Paige McGuirk', slug: 'paige-mcguirk' });
  });

  it('reads name from props.name when agentInfo/agent are absent', () => {
    const ident = findAgentIdentity(
      { data: { agentProfileProps: { name: 'Top Level Name' } } },
      'top-level'
    );
    expect(ident).toEqual({ name: 'Top Level Name', slug: 'top-level' });
  });

  it('leaves name undefined (empty fallback) when no identity is present at all', () => {
    const ident = findAgentIdentity(
      { data: { agentProfileProps: {} } },
      'some-agent'
    );
    expect(ident.name).toBeUndefined();
    expect(ident.slug).toBe('some-agent');
  });
});

describe('compass_get_agent_listings tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerAgentListingsTools(server, mockClient)
    );
  });

  it('fetches /agents/<slug>/ and returns formatted active listings', async () => {
    mockFetchHtml.mockResolvedValueOnce(agentProfileHtml(agentProfileData));
    const r = await harness.callTool('compass_get_agent_listings', {
      slug: 'paige-mcguirk',
    });
    expect(r.isError).toBeFalsy();
    expect(mockFetchHtml.mock.calls[0][0]).toBe('/agents/paige-mcguirk/');
    const parsed = parseToolResult<{
      agent: { name?: string; slug?: string };
      active_listings: Array<{
        listing_id_sha?: string;
        address?: string;
        price?: number;
        beds?: number;
        lot_size_acres?: number | null;
        url?: string;
      }>;
      closed_deals?: unknown[];
    }>(r);
    expect(parsed.agent).toEqual({ name: 'Paige McGuirk', slug: 'paige-mcguirk' });
    expect(parsed.active_listings).toHaveLength(2);
    // Same normalized fields as compass_get_property.
    expect(parsed.active_listings[0].listing_id_sha).toBe('sha-active-1');
    expect(parsed.active_listings[0].address).toBe('1 Active Rd');
    expect(parsed.active_listings[0].price).toBe(1_200_000);
    expect(parsed.active_listings[0].beds).toBe(3);
    // 45,738 sqft → 1.05 acres, proving the formatter ran on the records.
    expect(parsed.active_listings[0].lot_size_acres).toBe(1.05);
    expect(parsed.active_listings[0].url).toBe(
      'https://www.compass.com/homedetails/1-Active-Rd-Queens-NY-11357/sha-active-1_lid/'
    );
    // Closed deals are opt-in — omitted by default.
    expect(parsed.closed_deals).toBeUndefined();
  });

  it('accepts a bare slug AND a full profile_url, fetching the same path', async () => {
    mockFetchHtml.mockResolvedValueOnce(agentProfileHtml(agentProfileData));
    await harness.callTool('compass_get_agent_listings', {
      profile_url: 'https://www.compass.com/agents/paige-mcguirk/',
    });
    expect(mockFetchHtml.mock.calls[0][0]).toBe('/agents/paige-mcguirk/');
  });

  it('includes closed_deals only when include_closed: true', async () => {
    mockFetchHtml.mockResolvedValueOnce(agentProfileHtml(agentProfileData));
    const r = await harness.callTool('compass_get_agent_listings', {
      slug: 'paige-mcguirk',
      include_closed: true,
    });
    const parsed = parseToolResult<{
      active_listings: unknown[];
      closed_deals?: Array<{ listing_id_sha?: string; localized_status?: string }>;
    }>(r);
    expect(parsed.closed_deals).toBeDefined();
    expect(parsed.closed_deals).toHaveLength(1);
    expect(parsed.closed_deals?.[0].listing_id_sha).toBe('sha-closed-1');
    expect(parsed.closed_deals?.[0].localized_status).toBe('Sold');
  });

  it('errors clearly when neither slug nor profile_url is provided', async () => {
    const r = await harness.callTool('compass_get_agent_listings', {});
    expect(r.isError).toBeTruthy();
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/slug|profile_url/i);
  });

  it('errors clearly when __AGENT_PROFILE__ is absent from the page', async () => {
    mockFetchHtml.mockResolvedValueOnce('<html>no agent blob here</html>');
    const r = await harness.callTool('compass_get_agent_listings', {
      slug: 'paige-mcguirk',
    });
    expect(r.isError).toBeTruthy();
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/__AGENT_PROFILE__/);
  });

  it('returns an empty active_listings array (not an error) for an agent with no active listings', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      agentProfileHtml({
        data: {
          agentProfileProps: {
            agentInfo: { name: 'New Agent', slug: 'new-agent' },
            activeListingsProps: { initialSales: [] },
          },
        },
      })
    );
    const r = await harness.callTool('compass_get_agent_listings', {
      slug: 'new-agent',
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{ active_listings: unknown[] }>(r);
    expect(parsed.active_listings).toEqual([]);
  });
});
