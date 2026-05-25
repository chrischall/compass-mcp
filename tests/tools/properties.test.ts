import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { CompassClient } from '../../src/client.js';
import {
  buildPath,
  findListing,
  format,
  registerPropertyTools,
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
  // Compass routes homedetails by `/homedetails/<slug>/<sha>_lid/` and
  // returns 410 Gone for the slug-less `/homedetails/<sha>_lid/` form.
  // The search response always carries a full URL with both segments —
  // the caller must pass that `url`, not the bare `listing_id_sha`.
  it('rejects listing_id_sha without a url (compass 410s the slug-less form)', () => {
    expect(() => buildPath({ listing_id_sha: 'abc123' })).toThrow(
      /listing_id_sha alone is not enough/i
    );
    // The error must point the caller at the search result's `url` field
    // so the next-best-action is obvious to both humans and LLMs.
    expect(() => buildPath({ listing_id_sha: 'abc123' })).toThrow(/url/);
  });

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

  it('returns a clear error when called with listing_id_sha alone', async () => {
    const r = await harness.callTool('compass_get_property', {
      listing_id_sha: '2079240952806311449',
    });
    expect(r.isError).toBeTruthy();
    const text = (r.content[0] as { text: string }).text;
    // Must explain the failure and point at the `url` field of search results.
    expect(text).toMatch(/listing_id_sha alone is not enough/i);
    expect(text).toMatch(/url/);
    // Must NOT have fired an HTTP fetch — we short-circuit before the bridge.
    expect(mockFetchHtml).not.toHaveBeenCalled();
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
});
