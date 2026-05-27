import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { CompassClient } from '../../src/client.js';
import { registerComparableRentalsTools } from '../../src/tools/comparable-rentals.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as CompassClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

const homedetailsHtml = (listing: unknown) => {
  const data = { props: { listingRelation: { listing } } };
  return `<html><script>window.__INITIAL_DATA__ = ${JSON.stringify(data)};</script></html>`;
};

const rentalSearchHtml = (listings: unknown[]) => {
  const uc = {
    sharedReactAppProps: {
      initialResults: {
        lolResults: { totalItems: listings.length, data: listings },
      },
    },
  };
  return `<html><script>global.uc = ${JSON.stringify(uc)};</script></html>`;
};

describe('compass_get_comparable_rentals', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerComparableRentalsTools(server, mockClient)
    );
  });

  it('fetches the target property then searches nearby rentals by city + zip', async () => {
    // First call: fetch the target homedetails page to lift location.
    // Second call: search /homes-for-sale/.../type-rental/ for the same area.
    mockFetchHtml.mockImplementation(async (path: string) => {
      if (path.includes('_lid')) {
        return homedetailsHtml({
          listingIdSHA: 'target',
          pageLink: '/h/target_lid/',
          location: {
            prettyAddress: '126 Sleeping Bear Ln',
            city: 'Lake Lure',
            state: 'NC',
            zipCode: '28746',
          },
          size: { bedrooms: 3 },
        });
      }
      return rentalSearchHtml([
        {
          listing: {
            listingIdSHA: 'r1',
            pageLink: '/h/r1_lid/',
            title: '$3,500/mo',
            subtitles: ['1 Lake Way', 'Lake Lure, NC 28746'],
            subStats: [{ title: 'beds', subtitle: '3' }],
          },
        },
        {
          listing: {
            listingIdSHA: 'r2',
            pageLink: '/h/r2_lid/',
            title: '$2,800/mo',
            subtitles: ['2 Lake Way', 'Lake Lure, NC 28746'],
            subStats: [{ title: 'beds', subtitle: '2' }],
          },
        },
      ]);
    });

    const r = await harness.callTool('compass_get_comparable_rentals', {
      url: '/h/target_lid/',
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      target: { city?: string; state?: string; zip?: string };
      count: number;
      rentals: Array<{ listing_id_sha: string; address?: string }>;
    }>(r);
    expect(parsed.target.city).toBe('Lake Lure');
    expect(parsed.target.zip).toBe('28746');
    expect(parsed.count).toBe(2);
    expect(parsed.rentals.map((r) => r.listing_id_sha)).toEqual(['r1', 'r2']);
    // The search URL was rental-typed.
    const searchPath = mockFetchHtml.mock.calls[1][0] as string;
    expect(searchPath).toContain('type-rental');
  });

  it('uses prettyAddress as the search seed when zip and city/state are absent', async () => {
    // This guards the operator-precedence fix in the locationSeed
    // chain. `[city, state].filter(...).join(', ')` returns '' when
    // both are missing — `??` would stop on the empty string and the
    // `prettyAddress` branch would be unreachable. We need `||` between
    // the join result and `prettyAddress`.
    mockFetchHtml.mockImplementation(async (path: string) => {
      if (path.includes('_lid')) {
        return homedetailsHtml({
          listingIdSHA: 'target',
          pageLink: '/h/target_lid/',
          location: {
            prettyAddress: '126 Sleeping Bear Ln',
            // No city, state, or zip — only prettyAddress is present.
          },
        });
      }
      return rentalSearchHtml([]);
    });
    const r = await harness.callTool('compass_get_comparable_rentals', {
      url: '/h/target_lid/',
    });
    const parsed = parseToolResult<{ count: number; warning?: string }>(r);
    // Tool should have proceeded to the rental search (count is 0
    // because we returned no rentals), NOT short-circuited with the
    // 'no locality data' warning.
    expect(parsed.warning).toBeUndefined();
    expect(parsed.count).toBe(0);
    // Confirm the search URL was actually fetched (i.e. we used the
    // prettyAddress as the seed).
    expect(mockFetchHtml.mock.calls.length).toBe(2);
  });

  it('returns an empty rentals[] when the target has no matching area', async () => {
    mockFetchHtml.mockImplementation(async (path: string) => {
      if (path.includes('_lid')) {
        return homedetailsHtml({
          listingIdSHA: 'target',
          pageLink: '/h/target_lid/',
          location: {
            city: 'Tinytown',
            state: 'XX',
            zipCode: '00000',
          },
        });
      }
      return rentalSearchHtml([]);
    });
    const r = await harness.callTool('compass_get_comparable_rentals', {
      url: '/h/target_lid/',
    });
    const parsed = parseToolResult<{ count: number }>(r);
    expect(parsed.count).toBe(0);
  });
});
