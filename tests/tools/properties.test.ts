import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { CompassClient } from '../../src/client.js';
import {
  buildPath,
  findListing,
  format,
  registerPropertyTools,
  resolvePathFromSha,
} from '../../src/tools/properties.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as CompassClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

describe('buildPath', () => {
  it('preserves a path-shaped URL', () => {
    expect(buildPath({ url: '/homedetails/foo/abc_lid/' })).toBe(
      '/homedetails/foo/abc_lid/'
    );
  });

  it('reduces a full URL to its path', () => {
    expect(buildPath({ url: 'https://www.compass.com/homedetails/foo/abc_lid/' })).toBe(
      '/homedetails/foo/abc_lid/'
    );
  });

  it('throws when neither argument is provided', () => {
    expect(() => buildPath({})).toThrow(/listing_id_sha or url/);
  });

  it('returns null for a sha-only call so callers can run the async resolver', () => {
    // buildPath is sync, and sha-only resolution needs an HTTP call.
    // Returning null here lets fetchListingRecord branch to the async
    // resolver without buildPath having to take a client.
    expect(buildPath({ listing_id_sha: 'abc123' })).toBeNull();
  });
});

describe('resolvePathFromSha', () => {
  it('searches /homes-for-sale/?q=<sha> and returns the matching pageLink', async () => {
    const uc = {
      sharedReactAppProps: {
        initialResults: {
          lolResults: {
            data: [
              {
                listing: {
                  listingIdSHA: '1887095624271872617',
                  pageLink:
                    '/homedetails/126-Sleeping-Bear-Ln-Lake-Lure-NC-28746/1887095624271872617_lid/',
                },
              },
            ],
          },
        },
      },
    };
    const html = `<html><script>global.uc = ${JSON.stringify(uc)};</script></html>`;
    const fetchHtml = vi.fn().mockResolvedValueOnce(html);
    const client = { fetchHtml } as unknown as CompassClient;

    const path = await resolvePathFromSha(client, '1887095624271872617');
    expect(fetchHtml).toHaveBeenCalledWith(
      '/homes-for-sale/?q=1887095624271872617'
    );
    expect(path).toBe(
      '/homedetails/126-Sleeping-Bear-Ln-Lake-Lure-NC-28746/1887095624271872617_lid/'
    );
  });

  it('throws a clear error when no result matches the sha', async () => {
    const uc = {
      sharedReactAppProps: {
        initialResults: { lolResults: { data: [] } },
      },
    };
    const fetchHtml = vi
      .fn()
      .mockResolvedValue(
        `<html><script>global.uc = ${JSON.stringify(uc)};</script></html>`
      );
    const client = { fetchHtml } as unknown as CompassClient;
    await expect(resolvePathFromSha(client, 'unknown-sha')).rejects.toThrow(
      /unknown-sha/
    );
    await expect(resolvePathFromSha(client, 'unknown-sha')).rejects.toThrow(
      /url/
    );
  });
});

describe('findListing', () => {
  it('pulls listing from __INITIAL_DATA__.props.listingRelation.listing', () => {
    const data = {
      props: {
        listingRelation: { listing: { listingIdSHA: 'abc', status: 14 } },
      },
    };
    expect(findListing(data)).toEqual({ listingIdSHA: 'abc', status: 14 });
  });

  it('returns null when the path is missing', () => {
    expect(findListing({})).toBeNull();
    expect(findListing({ props: {} })).toBeNull();
  });
});

describe('format', () => {
  it('flattens a typical homedetails listing record', () => {
    const out = format({
      listingIdSHA: '2109718971930079225',
      compassPropertyId: 12345,
      pageLink: '/homedetails/foo/2109718971930079225_lid/',
      navigationPageLink: '/homedetails/foo/203T5X_pid/',
      status: 14,
      localizedStatus: 'Coming Soon',
      mlsStatus: 'COMING_SOON',
      isOffMLS: false,
      parcelNumber: '01987 0031',
      description: 'A lovely home.',
      date: {
        contract: 1779433200000,
        updated: 1779433200000,
      },
      location: {
        prettyAddress: '162-04 12th Road',
        city: 'Queens',
        state: 'NY',
        zipCode: '11357',
        neighborhood: 'Beechhurst',
        latitude: 40.79,
        longitude: -73.8,
      },
      size: {
        bedrooms: 3,
        totalBathrooms: 4,
        fullBathrooms: 3,
        halfBathrooms: 1,
        squareFeet: 3400,
        lotSizeInSquareFeet: 4500,
        formattedLotSize: "4,500 SF / 45' x 100'",
        totalRooms: 6,
      },
      price: {
        formatted: '$2,498,000',
        lastKnown: 2498000,
        lastAsking: 2498000,
        perSquareFoot: 734.71,
        monthlySalesChargesInclTaxes: 929.23,
      },
      detailedInfo: {
        amenities: ['Patio', 'Fireplace'],
        schools: [
          {
            name: 'PS 193',
            distance: '0.52',
            gradesOffered: 'PK-5',
            greatSchoolsRating: 7,
            types: ['Public'],
          },
        ],
        architecturalStyle: 'Colonial',
        garageSpaces: 1,
        totalParkingSpaces: 2,
      },
    });

    expect(out.listing_id_sha).toBe('2109718971930079225');
    expect(out.compass_property_id).toBe(12345);
    expect(out.url).toBe(
      'https://www.compass.com/homedetails/foo/2109718971930079225_lid/'
    );
    expect(out.property_url).toBe(
      'https://www.compass.com/homedetails/foo/203T5X_pid/'
    );
    expect(out.address).toBe('162-04 12th Road');
    expect(out.beds).toBe(3);
    expect(out.baths).toBe(4);
    expect(out.full_baths).toBe(3);
    expect(out.half_baths).toBe(1);
    expect(out.sqft).toBe(3400);
    expect(out.price_per_sqft).toBeCloseTo(734.71);
    expect(out.monthly_charges).toBeCloseTo(929.23);
    expect(out.amenities).toEqual(['Patio', 'Fireplace']);
    expect(out.schools).toEqual([
      {
        name: 'PS 193',
        distance: '0.52',
        grades: 'PK-5',
        great_schools_rating: 7,
        types: ['Public'],
      },
    ]);
  });

  it('synthesizes a URL when pageLink is missing', () => {
    const out = format({ listingIdSHA: 'abc' });
    expect(out.url).toBe('https://www.compass.com/homedetails/abc_lid/');
  });

  it('surfaces pid alongside listing_id_sha when navigationPageLink is a _pid/ form', () => {
    // Issue #27: `_pid/` URLs are stable across re-listings, `_lid/`
    // URLs are content-addressed by sha and go stale. Callers building
    // trackers/bookmarks want the `pid` so they can construct the
    // stable URL form themselves.
    const out = format({
      listingIdSHA: '2109718971930079225',
      pageLink: '/homedetails/foo/2109718971930079225_lid/',
      navigationPageLink: '/homedetails/foo/203T5X_pid/',
    });
    expect(out.pid).toBe('203T5X');
    expect(out.listing_id_sha).toBe('2109718971930079225');
  });

  it('omits pid when no navigationPageLink is present', () => {
    const out = format({
      listingIdSHA: 'abc',
      pageLink: '/homedetails/foo/abc_lid/',
    });
    expect(out.pid).toBeUndefined();
  });
});

describe('compass_get_property tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerPropertyTools(server, mockClient)
    );
  });

  const htmlWith = (listing: unknown) => {
    const data = { props: { listingRelation: { listing } } };
    return `<html><script>window.__INITIAL_DATA__ = ${JSON.stringify(data)};</script></html>`;
  };

  it('fetches the homedetails page + returns the formatted record', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWith({
        listingIdSHA: 'abc',
        pageLink: '/homedetails/foo/abc_lid/',
        status: 14,
        localizedStatus: 'Coming Soon',
        location: { prettyAddress: '1 Main', city: 'Queens', state: 'NY' },
        size: { bedrooms: 3, totalBathrooms: 2 },
        price: { formatted: '$1M', lastKnown: 1000000 },
      })
    );
    const r = await harness.callTool('compass_get_property', {
      url: '/homedetails/foo/abc_lid/',
    });
    expect(r.isError).toBeFalsy();
    expect(mockFetchHtml.mock.calls[0][0]).toBe('/homedetails/foo/abc_lid/');
    const parsed = parseToolResult<{
      address: string;
      price: number;
      localized_status: string;
    }>(r);
    expect(parsed.address).toBe('1 Main');
    expect(parsed.price).toBe(1000000);
    expect(parsed.localized_status).toBe('Coming Soon');
  });

  it('resolves a sha-only call by searching for the slug, then fetches the listing', async () => {
    // Step 1: sha-only invocation triggers the resolver, which calls
    // /homes-for-sale/?q=<sha> and looks for the matching lolResults entry.
    const searchUc = {
      sharedReactAppProps: {
        initialResults: {
          lolResults: {
            totalItems: 1,
            data: [
              {
                listing: {
                  listingIdSHA: 'abc',
                  pageLink: '/homedetails/foo/abc_lid/',
                },
              },
            ],
          },
        },
      },
    };
    const searchHtml = `<html><script>global.uc = ${JSON.stringify(searchUc)};</script></html>`;
    // Step 2: the resolver path is then fetched normally for the listing record.
    const listingHtml = htmlWith({
      listingIdSHA: 'abc',
      pageLink: '/homedetails/foo/abc_lid/',
      location: { prettyAddress: '1 Main' },
    });
    mockFetchHtml
      .mockResolvedValueOnce(searchHtml)
      .mockResolvedValueOnce(listingHtml);

    const r = await harness.callTool('compass_get_property', {
      listing_id_sha: 'abc',
    });
    expect(r.isError).toBeFalsy();
    expect(mockFetchHtml.mock.calls.map((c) => c[0])).toEqual([
      '/homes-for-sale/?q=abc',
      '/homedetails/foo/abc_lid/',
    ]);
    const parsed = parseToolResult<{ address: string; listing_id_sha: string }>(r);
    expect(parsed.address).toBe('1 Main');
    expect(parsed.listing_id_sha).toBe('abc');
  });

  it('returns a clear error when a sha-only call resolves to nothing', async () => {
    // Resolver returns no matching entry → tool surfaces a helpful error
    // that names the next-best-action: pass the `url` from a search result.
    const searchUc = {
      sharedReactAppProps: {
        initialResults: { lolResults: { totalItems: 0, data: [] } },
      },
    };
    mockFetchHtml.mockResolvedValueOnce(
      `<html><script>global.uc = ${JSON.stringify(searchUc)};</script></html>`
    );
    const r = await harness.callTool('compass_get_property', {
      listing_id_sha: 'no-such-sha',
    });
    expect(r.isError).toBeTruthy();
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/no-such-sha/);
    expect(text).toMatch(/url/);
  });

  it('throws when __INITIAL_DATA__ is absent', async () => {
    mockFetchHtml.mockResolvedValueOnce('<html>no init data</html>');
    const r = await harness.callTool('compass_get_property', {
      url: '/homedetails/foo/abc_lid/',
    });
    expect(r.isError).toBeTruthy();
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/Could not locate __INITIAL_DATA__/);
  });

  describe('P1 derived schema (issues #36, #37, #38, #43, #44)', () => {
    const htmlWith = (listing: unknown) => {
      const data = { props: { listingRelation: { listing } } };
      return `<html><script>window.__INITIAL_DATA__ = ${JSON.stringify(data)};</script></html>`;
    };

    it('emits portal_url_hyperlink in =HYPERLINK(_pid/) form when pid is present (#43)', async () => {
      mockFetchHtml.mockResolvedValueOnce(
        htmlWith({
          listingIdSHA: 'abc',
          pageLink: '/homedetails/foo/abc_lid/',
          navigationPageLink: '/homedetails/foo/203T5X_pid/',
        })
      );
      const r = await harness.callTool('compass_get_property', {
        url: '/homedetails/foo/abc_lid/',
      });
      const parsed = parseToolResult<{ portal_url_hyperlink?: string }>(r);
      expect(parsed.portal_url_hyperlink).toBe(
        '=HYPERLINK("https://www.compass.com/homedetails/foo/203T5X_pid/","Compass")'
      );
    });

    it('falls back to _lid/ in portal_url_hyperlink when no pid is available (#43)', async () => {
      mockFetchHtml.mockResolvedValueOnce(
        htmlWith({
          listingIdSHA: 'abc',
          pageLink: '/homedetails/foo/abc_lid/',
        })
      );
      const r = await harness.callTool('compass_get_property', {
        url: '/homedetails/foo/abc_lid/',
      });
      const parsed = parseToolResult<{ portal_url_hyperlink?: string }>(r);
      expect(parsed.portal_url_hyperlink).toBe(
        '=HYPERLINK("https://www.compass.com/homedetails/foo/abc_lid/","Compass")'
      );
    });

    it('hoa_monthly_usd is null when no hoa data is present (#36)', async () => {
      mockFetchHtml.mockResolvedValueOnce(
        htmlWith({ listingIdSHA: 'abc', pageLink: '/x/abc_lid/' })
      );
      const r = await harness.callTool('compass_get_property', { url: '/x/abc_lid/' });
      const parsed = parseToolResult<{ hoa_monthly_usd?: number | null }>(r);
      expect(parsed.hoa_monthly_usd).toBeNull();
    });

    it('hoa_monthly_usd converts Annually → /12 rounded (#36)', async () => {
      mockFetchHtml.mockResolvedValueOnce(
        htmlWith({
          listingIdSHA: 'abc',
          pageLink: '/x/abc_lid/',
          detailedInfo: {
            associationFee: { amount: 4967, frequency: 'Annually' },
          },
        })
      );
      const r = await harness.callTool('compass_get_property', { url: '/x/abc_lid/' });
      const parsed = parseToolResult<{ hoa_monthly_usd?: number }>(r);
      expect(parsed.hoa_monthly_usd).toBe(414);
    });

    it('hoa_monthly_usd: Quarterly → /3, Monthly passthrough (#36)', async () => {
      mockFetchHtml.mockResolvedValueOnce(
        htmlWith({
          listingIdSHA: 'a',
          pageLink: '/x/a_lid/',
          detailedInfo: {
            associationFee: { amount: 900, frequency: 'Quarterly' },
          },
        })
      );
      const r1 = await harness.callTool('compass_get_property', { url: '/x/a_lid/' });
      expect(parseToolResult<{ hoa_monthly_usd?: number }>(r1).hoa_monthly_usd).toBe(300);

      mockFetchHtml.mockResolvedValueOnce(
        htmlWith({
          listingIdSHA: 'b',
          pageLink: '/x/b_lid/',
          detailedInfo: {
            associationFee: { amount: 350, frequency: 'Monthly' },
          },
        })
      );
      const r2 = await harness.callTool('compass_get_property', { url: '/x/b_lid/' });
      expect(parseToolResult<{ hoa_monthly_usd?: number }>(r2).hoa_monthly_usd).toBe(350);
    });

    it('hoa_monthly_usd is null for unknown frequencies (#36)', async () => {
      mockFetchHtml.mockResolvedValueOnce(
        htmlWith({
          listingIdSHA: 'a',
          pageLink: '/x/a_lid/',
          detailedInfo: {
            associationFee: { amount: 100, frequency: 'WhenMyDogBarks' },
          },
        })
      );
      const r = await harness.callTool('compass_get_property', { url: '/x/a_lid/' });
      const parsed = parseToolResult<{ hoa_monthly_usd?: number | null }>(r);
      expect(parsed.hoa_monthly_usd).toBeNull();
    });

    it('tax_annual nulls out the 0/1 not-yet-assessed sentinel (#38)', async () => {
      mockFetchHtml.mockResolvedValueOnce(
        htmlWith({
          listingIdSHA: 'a',
          pageLink: '/x/a_lid/',
          detailedInfo: { taxAnnualAmount: 1 },
        })
      );
      const r = await harness.callTool('compass_get_property', { url: '/x/a_lid/' });
      const parsed = parseToolResult<{ tax_annual?: number | null }>(r);
      expect(parsed.tax_annual).toBeNull();
    });

    it('tax_annual passes through normal values (#38)', async () => {
      mockFetchHtml.mockResolvedValueOnce(
        htmlWith({
          listingIdSHA: 'a',
          pageLink: '/x/a_lid/',
          detailedInfo: { taxAnnualAmount: 8200 },
        })
      );
      const r = await harness.callTool('compass_get_property', { url: '/x/a_lid/' });
      const parsed = parseToolResult<{ tax_annual?: number | null }>(r);
      expect(parsed.tax_annual).toBe(8200);
    });

    it('days_on_market derived from the earliest Listed event (#37)', async () => {
      const tenDaysAgoMs = Date.now() - 10 * 86_400_000;
      mockFetchHtml.mockResolvedValueOnce(
        htmlWith({
          listingIdSHA: 'a',
          pageLink: '/x/a_lid/',
          events: [
            { timestamp: tenDaysAgoMs, status: 1, price: 500000, localizedStatus: 'Listed' },
          ],
        })
      );
      const r = await harness.callTool('compass_get_property', { url: '/x/a_lid/' });
      const parsed = parseToolResult<{ days_on_market?: number | null }>(r);
      expect(parsed.days_on_market).toBe(10);
    });

    it('days_on_market is null when no Listed event is present (#37)', async () => {
      mockFetchHtml.mockResolvedValueOnce(
        htmlWith({ listingIdSHA: 'a', pageLink: '/x/a_lid/' })
      );
      const r = await harness.callTool('compass_get_property', { url: '/x/a_lid/' });
      const parsed = parseToolResult<{ days_on_market?: number | null }>(r);
      expect(parsed.days_on_market).toBeNull();
    });

    it('price_drop_amount + price_drop_percent from event-derived previous list price (#37)', async () => {
      mockFetchHtml.mockResolvedValueOnce(
        htmlWith({
          listingIdSHA: 'a',
          pageLink: '/x/a_lid/',
          price: { lastKnown: 480000 },
          events: [
            { timestamp: 1000, status: 1, price: 500000, localizedStatus: 'Listed' },
          ],
        })
      );
      const r = await harness.callTool('compass_get_property', { url: '/x/a_lid/' });
      const parsed = parseToolResult<{
        price_drop_amount?: number | null;
        price_drop_percent?: number | null;
      }>(r);
      expect(parsed.price_drop_amount).toBe(20000);
      expect(parsed.price_drop_percent).toBe(4.0);
    });

    it('price_drop_* are null when there is no prior list event (#37)', async () => {
      mockFetchHtml.mockResolvedValueOnce(
        htmlWith({
          listingIdSHA: 'a',
          pageLink: '/x/a_lid/',
          price: { lastKnown: 480000 },
        })
      );
      const r = await harness.callTool('compass_get_property', { url: '/x/a_lid/' });
      const parsed = parseToolResult<{
        price_drop_amount?: number | null;
        price_drop_percent?: number | null;
      }>(r);
      expect(parsed.price_drop_amount).toBeNull();
      expect(parsed.price_drop_percent).toBeNull();
    });

    it('address_alternates surfaces an alternate MLS address when it differs (#44)', async () => {
      mockFetchHtml.mockResolvedValueOnce(
        htmlWith({
          listingIdSHA: 'a',
          pageLink: '/x/a_lid/',
          location: { prettyAddress: '169 Overlook Point Ln' },
          mlsAlternateAddresses: ['109 Overlook Point Ln'],
        })
      );
      const r = await harness.callTool('compass_get_property', { url: '/x/a_lid/' });
      const parsed = parseToolResult<{ address_alternates?: string[] }>(r);
      expect(parsed.address_alternates).toEqual(['109 Overlook Point Ln']);
    });

    it('address_alternates is omitted when no alternates exist (#44)', async () => {
      mockFetchHtml.mockResolvedValueOnce(
        htmlWith({
          listingIdSHA: 'a',
          pageLink: '/x/a_lid/',
          location: { prettyAddress: '169 Overlook Point Ln' },
        })
      );
      const r = await harness.callTool('compass_get_property', { url: '/x/a_lid/' });
      const parsed = parseToolResult<{ address_alternates?: string[] }>(r);
      expect(parsed.address_alternates).toBeUndefined();
    });

    it('address_alternates drops duplicates of the primary (#44)', async () => {
      mockFetchHtml.mockResolvedValueOnce(
        htmlWith({
          listingIdSHA: 'a',
          pageLink: '/x/a_lid/',
          location: { prettyAddress: '169 Overlook Point Ln' },
          mlsAlternateAddresses: ['169 OVERLOOK POINT LN.'],
        })
      );
      const r = await harness.callTool('compass_get_property', { url: '/x/a_lid/' });
      const parsed = parseToolResult<{ address_alternates?: string[] }>(r);
      expect(parsed.address_alternates).toBeUndefined();
    });
  });

  describe('include_description + extracted_features (issues #34, #35)', () => {
    const htmlWith = (listing: unknown) => {
      const data = { props: { listingRelation: { listing } } };
      return `<html><script>window.__INITIAL_DATA__ = ${JSON.stringify(data)};</script></html>`;
    };

    const richDescription =
      'Lakefront retreat with a private dock, a hot tub on the deck, and an unfinished basement. Set in Rumbling Bald — sold fully furnished.';

    it('omits raw description by default but populates extracted_features', async () => {
      mockFetchHtml.mockResolvedValueOnce(
        htmlWith({
          listingIdSHA: 'abc',
          pageLink: '/homedetails/foo/abc_lid/',
          description: richDescription,
          location: { prettyAddress: '1 Main' },
        })
      );
      const r = await harness.callTool('compass_get_property', {
        url: '/homedetails/foo/abc_lid/',
      });
      const parsed = parseToolResult<{
        description?: string;
        extracted_features?: {
          lake_front: boolean;
          hot_tub: boolean;
          basement: string | null;
          furnished: string | null;
          dock: string | null;
          community: string | null;
        };
      }>(r);
      // Default behaviour: caller does not see the raw prose.
      expect(parsed.description).toBeUndefined();
      // But every structured signal is present.
      expect(parsed.extracted_features).toEqual({
        lake_front: true,
        hot_tub: true,
        basement: 'unfinished',
        furnished: 'fully',
        dock: 'private',
        community: 'Rumbling Bald',
      });
    });

    it('returns the raw description when include_description=true', async () => {
      mockFetchHtml.mockResolvedValueOnce(
        htmlWith({
          listingIdSHA: 'abc',
          pageLink: '/homedetails/foo/abc_lid/',
          description: richDescription,
          location: { prettyAddress: '1 Main' },
        })
      );
      const r = await harness.callTool('compass_get_property', {
        url: '/homedetails/foo/abc_lid/',
        include_description: true,
      });
      const parsed = parseToolResult<{
        description?: string;
        extracted_features?: unknown;
      }>(r);
      expect(parsed.description).toBe(richDescription);
      expect(parsed.extracted_features).toBeDefined();
    });
  });
});
