import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { CompassClient } from '../../src/client.js';
import {
  buildSearchPath,
  findLolResults,
  formatHome,
  registerSearchTools,
} from '../../src/tools/search.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as CompassClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

describe('buildSearchPath', () => {
  it('slugifies the bare location with no filters', () => {
    expect(buildSearchPath({ location: 'Brooklyn, NY' })).toBe(
      '/homes-for-sale/brooklyn-ny/'
    );
  });

  it('encodes a beds range', () => {
    expect(
      buildSearchPath({ location: 'New York, NY', beds_min: 2, beds_max: 3 })
    ).toBe('/homes-for-sale/new-york-ny/2-3-bed/');
  });

  it('encodes a price range', () => {
    expect(
      buildSearchPath({ location: 'x', price_min: 500000, price_max: 1200000 })
    ).toBe('/homes-for-sale/x/500000-1200000-price/');
  });

  it('omits an open-ended price max', () => {
    expect(buildSearchPath({ location: 'x', price_min: 500000 })).toBe(
      '/homes-for-sale/x/500000--price/'
    );
  });

  it('encodes a home type after the other filters', () => {
    expect(
      buildSearchPath({
        location: 'x',
        beds_min: 2,
        beds_max: 3,
        price_min: 500000,
        price_max: 1200000,
        home_type: 'condo',
      })
    ).toBe('/homes-for-sale/x/2-3-bed/500000-1200000-price/type-condo/');
  });

  it('omits a /page-1/ segment for the first page', () => {
    // Compass canonicalizes page 1 to the unsuffixed URL; appending
    // /page-1/ produces a redirect, so we drop it.
    expect(buildSearchPath({ location: 'x', page: 1 })).toBe(
      '/homes-for-sale/x/'
    );
  });

  it('appends a /page-N/ segment after the filters for N > 1', () => {
    expect(
      buildSearchPath({
        location: 'x',
        beds_min: 2,
        beds_max: 3,
        page: 2,
      })
    ).toBe('/homes-for-sale/x/2-3-bed/page-2/');
  });
});

describe('formatHome', () => {
  it('extracts the listing card fields into the canonical shape', () => {
    const out = formatHome({
      listing: {
        listingIdSHA: '2109718971930079225',
        pageLink: '/homedetails/foo/2109718971930079225_lid/',
        navigationPageLink: '/homedetails/foo/203T5X_pid/',
        title: '$2,498,000',
        subtitles: ['162-04 12th Road', 'Beechhurst'],
        status: 14,
        location: { latitude: 40.79, longitude: -73.8 },
        media: [
          { originalUrl: 'https://cdn/img-origin.jpg', thumbnailUrl: 'https://cdn/img-thumb.jpg' },
        ],
        subStats: [
          { title: 'beds', subtitle: '3' },
          { title: 'baths', subtitle: '4' },
          { title: 'sqft', subtitle: '3,400' },
        ],
        clusterSummary: {
          bedrooms: 3,
          bathrooms: 3.5,
          priceRange: [2498000],
          formattedLotSize: "4,500 SF / 45' x 100'",
          savedListing: false,
        },
      },
    });
    expect(out).toEqual({
      listing_id_sha: '2109718971930079225',
      pid: '203T5X',
      url: 'https://www.compass.com/homedetails/foo/2109718971930079225_lid/',
      property_url: 'https://www.compass.com/homedetails/foo/203T5X_pid/',
      address: '162-04 12th Road',
      neighborhood: 'Beechhurst',
      price_formatted: '$2,498,000',
      price_min: 2498000,
      price_max: undefined,
      beds: 3,
      baths: 4,
      sqft: 3400,
      lot_size: "4,500 SF / 45' x 100'",
      latitude: 40.79,
      longitude: -73.8,
      primary_photo_url: 'https://cdn/img-origin.jpg',
      primary_thumbnail_url: 'https://cdn/img-thumb.jpg',
      status: 14,
      saved: false,
    });
  });

  it('returns null when listingIdSHA is missing', () => {
    expect(formatHome({ listing: {} })).toBeNull();
    expect(formatHome({})).toBeNull();
  });

  it('falls back to clusterSummary beds/baths when subStats are missing', () => {
    const out = formatHome({
      listing: {
        listingIdSHA: '1',
        clusterSummary: { bedrooms: 2, bathrooms: 1.5 },
      },
    });
    expect(out?.beds).toBe(2);
    expect(out?.baths).toBe(1.5);
  });

  it('surfaces pid alongside listing_id_sha when navigationPageLink is a _pid/ form', () => {
    // Issue #27: `_pid/` URLs survive re-listings, `_lid/` URLs do not.
    // Callers tracking a property across listing cycles want the pid.
    const out = formatHome({
      listing: {
        listingIdSHA: '2109718971930079225',
        pageLink: '/homedetails/foo/2109718971930079225_lid/',
        navigationPageLink: '/homedetails/foo/203T5X_pid/',
      },
    });
    expect(out?.pid).toBe('203T5X');
    expect(out?.listing_id_sha).toBe('2109718971930079225');
  });

  it('omits pid when no navigationPageLink is present', () => {
    const out = formatHome({
      listing: {
        listingIdSHA: '1',
        pageLink: '/homedetails/foo/1_lid/',
      },
    });
    expect(out?.pid).toBeUndefined();
  });
});

describe('findLolResults', () => {
  it('reaches through uc.sharedReactAppProps.initialResults.lolResults', () => {
    const uc = {
      sharedReactAppProps: {
        initialResults: {
          lolResults: { totalItems: 99, data: [{ listing: { listingIdSHA: '1' } }] },
        },
      },
    };
    const lol = findLolResults(uc);
    expect(lol?.totalItems).toBe(99);
    expect(lol?.data).toHaveLength(1);
  });

  it('returns null when the path is missing', () => {
    expect(findLolResults({})).toBeNull();
  });
});

describe('compass_search_properties tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerSearchTools(server, mockClient)
    );
  });

  const htmlWith = (listings: unknown[]) => {
    const uc = {
      sharedReactAppProps: {
        initialResults: {
          lolResults: { totalItems: listings.length, data: listings },
        },
      },
    };
    return `<html><script>global.uc = ${JSON.stringify(uc)};</script></html>`;
  };

  it('fetches the SSR search page and returns formatted listings', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWith([
        {
          listing: {
            listingIdSHA: '1',
            pageLink: '/homedetails/a/1_lid/',
            title: '$1,000,000',
            subtitles: ['1 Main'],
            subStats: [{ title: 'beds', subtitle: '2' }],
          },
        },
        {
          listing: {
            listingIdSHA: '2',
            pageLink: '/homedetails/b/2_lid/',
            title: '$2,000,000',
            subtitles: ['2 Main'],
          },
        },
      ])
    );

    const r = await harness.callTool('compass_search_properties', {
      location: 'New York, NY',
      price_min: 1000000,
      price_max: 2500000,
    });
    expect(r.isError).toBeFalsy();
    expect(mockFetchHtml.mock.calls[0][0]).toBe(
      '/homes-for-sale/new-york-ny/1000000-2500000-price/'
    );
    const parsed = parseToolResult<{
      total_items: number;
      count: number;
      results: Array<{ listing_id_sha: string }>;
    }>(r);
    expect(parsed.total_items).toBe(2);
    expect(parsed.count).toBe(2);
    expect(parsed.results.map((x) => x.listing_id_sha)).toEqual(['1', '2']);
  });

  it('respects limit', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWith(
        Array.from({ length: 10 }, (_, i) => ({
          listing: { listingIdSHA: String(i + 1), pageLink: `/h/${i}/` },
        }))
      )
    );
    const r = await harness.callTool('compass_search_properties', {
      location: 'x',
      limit: 3,
    });
    const parsed = parseToolResult<{ results: unknown[] }>(r);
    expect(parsed.results).toHaveLength(3);
  });

  it('fetches additional Compass pages when limit exceeds one page', async () => {
    // Compass server-renders 5 listings per page; honoring a larger
    // limit means fetching /page-2/, /page-3/, etc. and concatenating.
    const page = (start: number, count: number, total: number) => {
      const listings = Array.from({ length: count }, (_, i) => ({
        listing: { listingIdSHA: String(start + i), pageLink: `/h/${start + i}/` },
      }));
      const uc = {
        sharedReactAppProps: {
          initialResults: {
            lolResults: { totalItems: total, data: listings },
          },
        },
      };
      return `<html><script>global.uc = ${JSON.stringify(uc)};</script></html>`;
    };
    mockFetchHtml
      .mockResolvedValueOnce(page(1, 5, 11)) // page 1
      .mockResolvedValueOnce(page(6, 5, 11)) // page 2
      .mockResolvedValueOnce(page(11, 1, 11)); // page 3 (partial)

    const r = await harness.callTool('compass_search_properties', {
      location: 'Mill Spring NC',
      price_min: 400000,
      price_max: 600000,
      limit: 11,
    });
    expect(r.isError).toBeFalsy();
    expect(mockFetchHtml.mock.calls.map((c) => c[0])).toEqual([
      '/homes-for-sale/mill-spring-nc/400000-600000-price/',
      '/homes-for-sale/mill-spring-nc/400000-600000-price/page-2/',
      '/homes-for-sale/mill-spring-nc/400000-600000-price/page-3/',
    ]);
    const parsed = parseToolResult<{
      count: number;
      total_items: number;
      results: Array<{ listing_id_sha: string }>;
      next_offset?: number;
    }>(r);
    expect(parsed.count).toBe(11);
    expect(parsed.total_items).toBe(11);
    expect(parsed.results.map((x) => x.listing_id_sha)).toEqual([
      '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11',
    ]);
    // All exhausted: no continuation cursor.
    expect(parsed.next_offset).toBeUndefined();
  });

  it('honors offset by skipping to the right Compass page', async () => {
    // offset=5 → start at page 2's first result. With limit=3 we get
    // listings 6,7,8 and a next_offset=8 for further paging.
    const uc = (data: unknown[], total: number) => ({
      sharedReactAppProps: {
        initialResults: { lolResults: { totalItems: total, data } },
      },
    });
    const html = (data: unknown[], total: number) =>
      `<html><script>global.uc = ${JSON.stringify(uc(data, total))};</script></html>`;
    const mk = (start: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        listing: { listingIdSHA: String(start + i), pageLink: `/h/${start + i}/` },
      }));
    mockFetchHtml.mockResolvedValueOnce(html(mk(6, 5), 11)); // page 2

    const r = await harness.callTool('compass_search_properties', {
      location: 'x',
      offset: 5,
      limit: 3,
    });
    expect(r.isError).toBeFalsy();
    expect(mockFetchHtml.mock.calls.map((c) => c[0])).toEqual([
      '/homes-for-sale/x/page-2/',
    ]);
    const parsed = parseToolResult<{
      count: number;
      results: Array<{ listing_id_sha: string }>;
      next_offset?: number;
    }>(r);
    expect(parsed.count).toBe(3);
    expect(parsed.results.map((x) => x.listing_id_sha)).toEqual(['6', '7', '8']);
    expect(parsed.next_offset).toBe(8);
  });

  it('surfaces next_offset when more results are available than were returned', async () => {
    // With totalItems=11 and we only got 5, the caller can request more.
    // (htmlWith sets totalItems = listings.length, so this test crafts
    // its own.)
    const uc = {
      sharedReactAppProps: {
        initialResults: {
          lolResults: {
            totalItems: 11,
            data: Array.from({ length: 5 }, (_, i) => ({
              listing: { listingIdSHA: String(i + 1), pageLink: `/h/${i}/` },
            })),
          },
        },
      },
    };
    mockFetchHtml.mockResolvedValueOnce(
      `<html><script>global.uc = ${JSON.stringify(uc)};</script></html>`
    );
    const r = await harness.callTool('compass_search_properties', {
      location: 'x',
      limit: 5,
    });
    const parsed = parseToolResult<{ next_offset?: number }>(r);
    expect(parsed.next_offset).toBe(5);
  });

  it('omits next_offset on a partial last page when totalItems is absent', async () => {
    // Without totalItems, a short page already signals exhaustion — the
    // fallback `collected.length >= limit` heuristic must not emit a
    // misleading `next_offset` in this case.
    const uc = {
      sharedReactAppProps: {
        initialResults: {
          lolResults: {
            // totalItems intentionally absent
            data: Array.from({ length: 3 }, (_, i) => ({
              listing: { listingIdSHA: String(i + 1), pageLink: `/h/${i}/` },
            })),
          },
        },
      },
    };
    mockFetchHtml.mockResolvedValueOnce(
      `<html><script>global.uc = ${JSON.stringify(uc)};</script></html>`
    );
    const r = await harness.callTool('compass_search_properties', {
      location: 'x',
      limit: 3,
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      count: number;
      total_items?: number;
      next_offset?: number;
    }>(r);
    expect(parsed.count).toBe(3);
    expect(parsed.total_items).toBeUndefined();
    expect(parsed.next_offset).toBeUndefined();
  });

  it('throws when uc can not be extracted from the HTML', async () => {
    mockFetchHtml.mockResolvedValueOnce('<html>no script here</html>');
    const r = await harness.callTool('compass_search_properties', {
      location: 'x',
    });
    expect(r.isError).toBeTruthy();
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/could not extract the uc state/);
  });
});
