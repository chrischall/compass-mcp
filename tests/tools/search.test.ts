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

  // Issue #87 (P1-3): Compass no longer paginates the SSR search via any
  // URL — `/page-N/`, `?page=N`, `?start=N` all canonicalize to page 1
  // and return identical listings (verified live). Only the first SSR
  // page (~COMPASS_PAGE_SIZE=41) is reachable. The tool must fetch ONLY
  // that page, never emit a /page-N/ URL, and never advertise a cursor
  // it can't honor.
  const ucHtml = (data: unknown[], total?: number) => {
    const lolResults: Record<string, unknown> = { data };
    if (total !== undefined) lolResults.totalItems = total;
    const uc = { sharedReactAppProps: { initialResults: { lolResults } } };
    return `<html><script>global.uc = ${JSON.stringify(uc)};</script></html>`;
  };
  const mkListings = (start: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      listing: { listingIdSHA: String(start + i), pageLink: `/h/${start + i}/` },
    }));

  it('#87: fetches ONLY page 1 (never a /page-N/ URL) even with a large limit', async () => {
    // The single reachable SSR page carries up to COMPASS_PAGE_SIZE (~41)
    // listings; a larger limit cannot fan out to /page-2/ because that
    // URL just re-returns page 1.
    mockFetchHtml.mockResolvedValueOnce(ucHtml(mkListings(1, 41), 104));
    const r = await harness.callTool('compass_search_properties', {
      location: 'Mill Spring NC',
      price_min: 400000,
      price_max: 600000,
      limit: 1000,
    });
    expect(r.isError).toBeFalsy();
    // Exactly one fetch, to the bare filtered path — no /page-N/.
    expect(mockFetchHtml.mock.calls.map((c) => c[0])).toEqual([
      '/homes-for-sale/mill-spring-nc/400000-600000-price/',
    ]);
    const parsed = parseToolResult<{
      count: number;
      total_items: number;
      next_offset?: number;
    }>(r);
    expect(parsed.count).toBe(41);
    expect(parsed.total_items).toBe(104);
    // The whole reachable page was returned — no false cursor past it,
    // even though total_items (104) is far larger.
    expect(parsed.next_offset).toBeUndefined();
  });

  it('#87 REGRESSION: a default limit-40 call does NOT advertise a re-fetch cursor', async () => {
    // The reported defect: total_items=104, next_offset=40, then
    // offset:40 -> page-9 -> identical first 40. With the honest model,
    // a 41-listing page truncated to limit 40 leaves 1 within the page,
    // so next_offset=40 IS legitimate here (more remains WITHIN page 1).
    mockFetchHtml.mockResolvedValueOnce(ucHtml(mkListings(1, 41), 104));
    const r = await harness.callTool('compass_search_properties', {
      location: 'x',
    });
    const parsed = parseToolResult<{
      count: number;
      next_offset?: number;
    }>(r);
    expect(parsed.count).toBe(40);
    // One listing remains within the reachable page → honest cursor.
    expect(parsed.next_offset).toBe(40);
  });

  it('#87 REGRESSION: offset:40 honors the intra-page position, not a bogus page-9 fetch', async () => {
    // The old code mapped offset 40 -> Math.floor(40/5)+1 = page-9 and
    // re-returned page 1. Now offset 40 just slices into the single
    // reachable page (which holds 41), returning the 41st listing.
    mockFetchHtml.mockResolvedValueOnce(ucHtml(mkListings(1, 41), 104));
    const r = await harness.callTool('compass_search_properties', {
      location: 'x',
      offset: 40,
    });
    expect(mockFetchHtml.mock.calls.map((c) => c[0])).toEqual([
      '/homes-for-sale/x/', // bare page 1 — NOT /page-9/
    ]);
    const parsed = parseToolResult<{
      count: number;
      offset: number;
      results: Array<{ listing_id_sha: string }>;
      next_offset?: number;
    }>(r);
    expect(parsed.offset).toBe(40);
    expect(parsed.count).toBe(1);
    expect(parsed.results.map((x) => x.listing_id_sha)).toEqual(['41']);
    // Page exhausted — no cursor past the reachable page.
    expect(parsed.next_offset).toBeUndefined();
  });

  it('#87: an offset at or beyond the reachable page returns nothing (can not reach page 2)', async () => {
    mockFetchHtml.mockResolvedValueOnce(ucHtml(mkListings(1, 41), 104));
    const r = await harness.callTool('compass_search_properties', {
      location: 'x',
      offset: 41,
    });
    expect(mockFetchHtml.mock.calls.map((c) => c[0])).toEqual([
      '/homes-for-sale/x/',
    ]);
    const parsed = parseToolResult<{ count: number; next_offset?: number }>(r);
    expect(parsed.count).toBe(0);
    expect(parsed.next_offset).toBeUndefined();
  });

  it('honors intra-page offset and emits an honest next_offset within the page', async () => {
    // offset 5, limit 3 over a 41-listing page → returns 6,7,8 and a
    // next_offset of 8 (more remains within the page).
    mockFetchHtml.mockResolvedValueOnce(ucHtml(mkListings(1, 41), 104));
    const r = await harness.callTool('compass_search_properties', {
      location: 'x',
      offset: 5,
      limit: 3,
    });
    expect(mockFetchHtml.mock.calls.map((c) => c[0])).toEqual([
      '/homes-for-sale/x/',
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

  it('omits next_offset when the whole reachable page fits under the limit', async () => {
    mockFetchHtml.mockResolvedValueOnce(ucHtml(mkListings(1, 3), 3));
    const r = await harness.callTool('compass_search_properties', {
      location: 'x',
      limit: 40,
    });
    const parsed = parseToolResult<{
      count: number;
      total_items?: number;
      next_offset?: number;
    }>(r);
    expect(parsed.count).toBe(3);
    expect(parsed.total_items).toBe(3);
    expect(parsed.next_offset).toBeUndefined();
  });

  it('omits next_offset on a short page when totalItems is absent', async () => {
    mockFetchHtml.mockResolvedValueOnce(ucHtml(mkListings(1, 3))); // no totalItems
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

  it('filters formatHome stubs without affecting the single-page model', async () => {
    // Cluster / "coming soon" entries without a listingIdSHA are dropped
    // by formatHome; the count reflects only the valid listings.
    const valid = mkListings(1, 4);
    const stubs = Array.from({ length: 2 }, () => ({ listing: {} }));
    mockFetchHtml.mockResolvedValueOnce(ucHtml([...valid, ...stubs], 6));
    const r = await harness.callTool('compass_search_properties', {
      location: 'x',
      limit: 40,
    });
    const parsed = parseToolResult<{
      count: number;
      results: Array<{ listing_id_sha: string }>;
      next_offset?: number;
    }>(r);
    expect(parsed.count).toBe(4);
    expect(parsed.results.map((x) => x.listing_id_sha)).toEqual([
      '1', '2', '3', '4',
    ]);
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

  /**
   * `view` on the one tool in this server that actually carries media.
   *
   * This is the tool the rollout missed: `compass_get_agent_listings` and
   * `compass_get_by_address` were wired, and neither emits a media field, so
   * `view` was present exactly where it did nothing and absent exactly where
   * it mattered. A search page returns ~41 listings and each one used to carry
   * two Compass CDN URLs a model can neither see nor fetch.
   */
  describe('view (issue #203)', () => {
    /** A listing whose media URLs are of BOTH shapes the strip must handle. */
    const withMedia = () =>
      ucHtml(
        [
          {
            listing: {
              listingIdSHA: '1',
              pageLink: '/homedetails/a/1_lid/',
              title: '$1,000,000',
              subtitles: ['1 Main', 'Park Slope'],
              media: [
                {
                  // Ends in an image extension.
                  originalUrl: 'https://cdn.compass.com/i/1.jpg',
                  thumbnailUrl: 'https://cdn.compass.com/t/1.jpg',
                },
              ],
            },
          },
          {
            listing: {
              listingIdSHA: '2',
              pageLink: '/homedetails/b/2_lid/',
              title: '$2,000,000',
              subtitles: ['2 Main', 'Park Slope'],
              media: [
                {
                  // Extension-less and signed. The library's VALUE rule cannot
                  // see this one, which is why view.ts drops these two keys by
                  // NAME rather than relying on the URL's shape.
                  originalUrl: 'https://cdn.compass.com/i/abc?sig=xyz',
                  thumbnailUrl: 'https://cdn.compass.com/t/abc?sig=xyz',
                },
              ],
            },
          },
        ],
        2
      );

    interface Result {
      listing_id_sha: string;
      address?: string;
      primary_photo_url?: string;
      primary_thumbnail_url?: string;
    }

    it('strips both media URLs from every listing by default', async () => {
      // Compact is the DEFAULT: a caller who has never heard of `view` gets
      // the smaller payload. An efficiency that has to be requested is one
      // that is usually not.
      mockFetchHtml.mockResolvedValueOnce(withMedia());
      const r = await harness.callTool('compass_search_properties', {
        location: 'x',
      });
      const parsed = parseToolResult<{ results: Result[] }>(r);
      for (const listing of parsed.results) {
        expect(listing.primary_photo_url).toBeUndefined();
        expect(listing.primary_thumbnail_url).toBeUndefined();
      }
      // Everything a caller acts on survives — compact removes the pictures,
      // not the listing.
      expect(parsed.results.map((x) => x.listing_id_sha)).toEqual(['1', '2']);
      expect(parsed.results.map((x) => x.address)).toEqual(['1 Main', '2 Main']);
    });

    it('strips the extension-less URL exactly like the .jpg one', async () => {
      // The regression this pins. Left to the library's built-in rules the
      // `.jpg` listing would lose its media and the signed one would keep it —
      // in the SAME response. A projection whose effect depends on the shape
      // of a URL is one a caller cannot reason about.
      mockFetchHtml.mockResolvedValueOnce(withMedia());
      const r = await harness.callTool('compass_search_properties', {
        location: 'x',
      });
      const text = (r.content[0] as { text: string }).text;
      expect(text).not.toContain('cdn.compass.com');
    });

    it('returns both media URLs under view: "full"', async () => {
      // `full` has to be a true escape hatch, or the parameter is decoration.
      mockFetchHtml.mockResolvedValueOnce(withMedia());
      const r = await harness.callTool('compass_search_properties', {
        location: 'x',
        view: 'full',
      });
      const parsed = parseToolResult<{ results: Result[] }>(r);
      expect(parsed.results[0].primary_photo_url).toBe(
        'https://cdn.compass.com/i/1.jpg'
      );
      expect(parsed.results[0].primary_thumbnail_url).toBe(
        'https://cdn.compass.com/t/1.jpg'
      );
      expect(parsed.results[1].primary_photo_url).toBe(
        'https://cdn.compass.com/i/abc?sig=xyz'
      );
      expect(parsed.results[1].primary_thumbnail_url).toBe(
        'https://cdn.compass.com/t/abc?sig=xyz'
      );
    });

    it('reports identical paging state in both rungs', async () => {
      // `view` is applied over the ASSEMBLED payload, after the slice. If it
      // were applied per-listing before paging, or if the strip reached the
      // paging scalars, a compact caller and a full caller would disagree
      // about how many listings exist — the one thing a size optimization
      // must never change.
      const listings = mkListings(1, 10);
      mockFetchHtml.mockResolvedValueOnce(ucHtml(listings, 99));
      const compact = parseToolResult<Record<string, unknown>>(
        await harness.callTool('compass_search_properties', {
          location: 'x',
          limit: 4,
        })
      );
      mockFetchHtml.mockResolvedValueOnce(ucHtml(listings, 99));
      const full = parseToolResult<Record<string, unknown>>(
        await harness.callTool('compass_search_properties', {
          location: 'x',
          limit: 4,
          view: 'full',
        })
      );
      for (const key of [
        'search_path',
        'total_items',
        'count',
        'offset',
        'next_offset',
      ]) {
        expect(compact[key]).toEqual(full[key]);
      }
      expect(compact.count).toBe(4);
      expect(compact.next_offset).toBe(4);
    });

    it('keeps a listing description byte-identical, blank lines and all', async () => {
      // Minification drops whitespace BETWEEN tokens, never whitespace inside
      // a value. A listing's prose paragraphing is the author's, and a
      // "minified" response that reflowed it would corrupt exactly the
      // payloads this exists to shrink.
      const description = "Sun-drenched corner unit.\n\n  Chef's kitchen.\n\tParking included.";
      mockFetchHtml.mockResolvedValueOnce(
        ucHtml(
          [
            {
              listing: {
                listingIdSHA: '1',
                pageLink: '/h/1/',
                // `subtitles[1]` becomes `neighborhood`, which is the nearest
                // free-text field a search card carries.
                subtitles: ['1 Main', description],
              },
            },
          ],
          1
        )
      );
      const r = await harness.callTool('compass_search_properties', {
        location: 'x',
      });
      const parsed = parseToolResult<{ results: Array<{ neighborhood: string }> }>(r);
      expect(parsed.results[0].neighborhood).toBe(description);
    });

    it('emits a single line of JSON', async () => {
      // Asserted on the serialized text, because it is the wire form and not
      // the parsed object that costs the caller. Pretty-printing 41 listings
      // is pure indentation tokens.
      mockFetchHtml.mockResolvedValueOnce(ucHtml(mkListings(1, 5), 5));
      const r = await harness.callTool('compass_search_properties', {
        location: 'x',
      });
      const text = (r.content[0] as { text: string }).text;
      expect(text).not.toContain('\n');
    });

    it('rejects a rung this server does not honour', async () => {
      // `raw` is a real rung elsewhere in the fleet's vocabulary. This server
      // does not implement it, and accepting it would mean silently answering
      // in some other rung than the caller asked for.
      const r = await harness.callTool('compass_search_properties', {
        location: 'x',
        view: 'raw',
      });
      expect(r.isError).toBeTruthy();
      // The schema rejects before the fetch, so no request is spent.
      expect(mockFetchHtml).not.toHaveBeenCalled();
    });
  });
});
