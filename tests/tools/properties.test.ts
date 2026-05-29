import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { CompassClient } from '../../src/client.js';
import {
  buildPath,
  findListing,
  format,
  lotSizeAcres,
  registerPropertyTools,
  resolvePathFromSha,
} from '../../src/tools/properties.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockFetchJson = vi.fn();
const mockClient = {
  fetchHtml: mockFetchHtml,
  fetchJson: mockFetchJson,
} as unknown as CompassClient;

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
  // The sha IS the listing id in `/listing/<id>/view`, and a GET of that
  // path 302-redirects to the canonical `/homedetails/<slug>/<sha>_lid/`
  // page (verified live, WAF-immune). So the resolver returns that path
  // directly — no omnisuggest call. Querying omnisuggest (an ADDRESS
  // typeahead) with a bare sha returns zero candidates, which is why the
  // prior #95 path always threw.

  it('returns the /listing/<sha>/view redirect path directly', async () => {
    const fetchJson = vi.fn();
    const fetchHtml = vi.fn();
    const client = { fetchHtml, fetchJson } as unknown as CompassClient;

    const path = await resolvePathFromSha(client, '1887095624271872617');
    expect(path).toBe('/listing/1887095624271872617/view');
    // No HTTP round-trip in the resolver itself — the sha maps straight
    // to the listing-view path. The downstream fetchHtml follows the 302.
    expect(fetchJson).not.toHaveBeenCalled();
    expect(fetchHtml).not.toHaveBeenCalled();
  });

  it('does NOT touch the omnisuggest typeahead (it returns nothing for a sha)', async () => {
    const fetchJson = vi.fn();
    const client = {
      fetchHtml: vi.fn(),
      fetchJson,
    } as unknown as CompassClient;
    await resolvePathFromSha(client, 'another-sha');
    expect(fetchJson).not.toHaveBeenCalled();
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

describe('lotSizeAcres (#82)', () => {
  it('45,738 sq ft → 1.05 acres', () => {
    // 45738 / 43560 = 1.0499… → rounds to 1.05
    expect(lotSizeAcres(45_738)).toBe(1.05);
  });
  it('13,503 sq ft → 0.31 acres', () => {
    expect(lotSizeAcres(13_503)).toBe(0.31);
  });
  it('94,089 sq ft → 2.16 acres', () => {
    expect(lotSizeAcres(94_089)).toBe(2.16);
  });
  it('rounds to 2 decimal places', () => {
    expect(lotSizeAcres(43_560)).toBe(1.0); // exactly one acre
    expect(lotSizeAcres(21_780)).toBe(0.5); // exactly half an acre
  });
  it('null / undefined lot size → null (not 0)', () => {
    expect(lotSizeAcres(null)).toBeNull();
    expect(lotSizeAcres(undefined)).toBeNull();
  });
  it('zero lot size → null (treated as missing, never 0 acres)', () => {
    expect(lotSizeAcres(0)).toBeNull();
  });
  it('tiny positive lot that rounds to 0.00 → null (never 0)', () => {
    // 200 / 43560 = 0.0046… → rounds to 0.00, which must null out so the
    // field stays consistent with the canonical cohort semantic.
    expect(lotSizeAcres(200)).toBeNull();
    expect(lotSizeAcres(200)).not.toBe(0);
  });
  it('non-finite input → null', () => {
    expect(lotSizeAcres(NaN)).toBeNull();
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
    expect(out.lot_size_sqft).toBe(4500);
    // 4500 / 43560 = 0.1033… → 0.10
    expect(out.lot_size_acres).toBe(0.1);
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

  it('derives lot_size_acres from lotSizeInSquareFeet for a SFH (#82)', () => {
    // Compass surfaces "1.05 AC / 45,738 SF" upstream — the sq-ft side is
    // lotSizeInSquareFeet, and lot_size_acres mirrors the AC side.
    const out = format({
      listingIdSHA: 'sfh',
      location: { prettyAddress: '158 Raven Blvd' },
      size: {
        squareFeet: 2400,
        lotSizeInSquareFeet: 45_738,
        formattedLotSize: '1.05 AC / 45,738 SF',
      },
    });
    expect(out.lot_size_sqft).toBe(45_738);
    expect(out.lot_size_acres).toBe(1.05);
  });

  it('lot_size_acres is null (not 0) for a condo with no lot (#82)', () => {
    const out = format({
      listingIdSHA: 'condo',
      location: { prettyAddress: '155 Quail Cove Blvd, Unit 4' },
      size: {
        squareFeet: 1100,
        // condo: no lotSizeInSquareFeet at all
      },
    });
    expect(out.lot_size_sqft).toBeUndefined();
    expect(out.lot_size_acres).toBeNull();
    // Must be null, never the 0 placeholder.
    expect(out.lot_size_acres).not.toBe(0);
  });

  it('lot_size_acres is null for a tiny lot that rounds to 0, but lot_size_sqft stays set', () => {
    // 200 sqft → 0.0046… acres → rounds to 0.00, which must null out even
    // though the raw sqft is a real, present value.
    const out = format({
      listingIdSHA: 'tiny',
      location: { prettyAddress: '1 Sliver Ln' },
      size: {
        squareFeet: 900,
        lotSizeInSquareFeet: 200,
      },
    });
    expect(out.lot_size_sqft).toBe(200);
    expect(out.lot_size_acres).toBeNull();
    expect(out.lot_size_acres).not.toBe(0);
  });

  describe('url preference order (#15)', () => {
    // Compass exposes several link fields on a listing. `url` should pick
    // the most-resolvable form: the slugged `pageLink` first, then the
    // stable `_pid/` `navigationPageLink`, and only as a genuine last
    // resort the slug-less `/homedetails/<sha>_lid/` form — which 410s on
    // compass.com but is the only thing derivable from a bare sha.

    it('prefers the slugged pageLink (_lid/) when present', () => {
      const out = format({
        listingIdSHA: 'abc',
        pageLink: '/homedetails/foo/abc_lid/',
        navigationPageLink: '/homedetails/foo/203T5X_pid/',
      });
      expect(out.url).toBe(
        'https://www.compass.com/homedetails/foo/abc_lid/'
      );
    });

    it('falls back to the resolvable _pid/ navigationPageLink when pageLink is absent', () => {
      // navigationPageLink is a working URL (it backs `property_url`),
      // so it must be preferred over the 410-ing slug-less _lid/ form.
      const out = format({
        listingIdSHA: 'abc',
        navigationPageLink: '/homedetails/foo/203T5X_pid/',
      });
      expect(out.url).toBe(
        'https://www.compass.com/homedetails/foo/203T5X_pid/'
      );
    });

    it('uses the slug-less _lid/ form only as a last resort (no pageLink, no navigationPageLink)', () => {
      // Benign last resort: this slug-less form 410s on compass.com, but
      // a bare sha can't be turned into a slugged URL without an extra
      // search lookup — so this is the only thing format() can synthesize.
      const out = format({ listingIdSHA: 'abc' });
      expect(out.url).toBe('https://www.compass.com/homedetails/abc_lid/');
    });
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

  it('surfaces lot_size_sqft + lot_size_acres for a SFH (#82)', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWith({
        listingIdSHA: 'sfh',
        pageLink: '/homedetails/foo/sfh_lid/',
        location: { prettyAddress: '158 Raven Blvd' },
        size: {
          squareFeet: 2400,
          lotSizeInSquareFeet: 45_738,
          formattedLotSize: '1.05 AC / 45,738 SF',
        },
        price: { lastKnown: 500_000 },
      })
    );
    const r = await harness.callTool('compass_get_property', {
      url: '/homedetails/foo/sfh_lid/',
    });
    const parsed = parseToolResult<{
      lot_size_sqft: number | undefined;
      lot_size_acres: number | null;
    }>(r);
    expect(parsed.lot_size_sqft).toBe(45_738);
    expect(parsed.lot_size_acres).toBe(1.05);
  });

  it('nulls lot_size_acres for a condo with no lot — never 0 (#82)', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWith({
        listingIdSHA: 'condo',
        pageLink: '/homedetails/foo/condo_lid/',
        location: { prettyAddress: '155 Quail Cove Blvd, Unit 4' },
        // condo: size carries no lotSizeInSquareFeet
        size: { bedrooms: 2, totalBathrooms: 2, squareFeet: 1100 },
        price: { lastKnown: 300_000 },
      })
    );
    const r = await harness.callTool('compass_get_property', {
      url: '/homedetails/foo/condo_lid/',
    });
    const parsed = parseToolResult<{
      lot_size_sqft: number | undefined;
      lot_size_acres: number | null;
    }>(r);
    expect(parsed.lot_size_acres).toBeNull();
    expect(parsed.lot_size_acres).not.toBe(0);
  });

  it('resolves a sha-only call via the /listing/<sha>/view redirect, then fetches the listing', async () => {
    // A sha-only invocation resolves to `/listing/<sha>/view` (no
    // omnisuggest call — that endpoint is an ADDRESS typeahead and
    // returns nothing for a sha). `fetchHtml` GETs that path; the bridge
    // follows the 302 to `/homedetails/<slug>/<sha>_lid/` and returns the
    // homedetails body, which the existing parser handles.
    const listingHtml = htmlWith({
      listingIdSHA: 'abc',
      pageLink: '/homedetails/foo/abc_lid/',
      location: { prettyAddress: '1 Main' },
    });
    mockFetchHtml.mockResolvedValueOnce(listingHtml);

    const r = await harness.callTool('compass_get_property', {
      listing_id_sha: 'abc',
    });
    expect(r.isError).toBeFalsy();
    // No omnisuggest round-trip; the listing-view path is fetched directly.
    expect(mockFetchJson).not.toHaveBeenCalled();
    expect(mockFetchHtml.mock.calls.map((c) => c[0])).toEqual([
      '/listing/abc/view',
    ]);
    const parsed = parseToolResult<{ address: string; listing_id_sha: string }>(r);
    expect(parsed.address).toBe('1 Main');
    expect(parsed.listing_id_sha).toBe('abc');
  });

  it('surfaces a clean downstream error when a bad sha 410s / hits the sign-in wall', async () => {
    // A genuinely bad/stale sha no longer fails in the resolver — it now
    // surfaces via the downstream fetchHtml. The client's GET of
    // `/listing/<sha>/view` either 410s (Gone) or hits the sign-in
    // interstitial; either way fetchHtml throws and the tool relays a
    // clean error rather than a cryptic one.
    mockFetchHtml.mockRejectedValueOnce(
      new Error('Compass API error: 410 for GET /listing/no-such-sha/view')
    );
    const r = await harness.callTool('compass_get_property', {
      listing_id_sha: 'no-such-sha',
    });
    expect(r.isError).toBeTruthy();
    expect(mockFetchJson).not.toHaveBeenCalled();
    expect(mockFetchHtml.mock.calls[0][0]).toBe('/listing/no-such-sha/view');
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/410/);
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

  describe('listing_agent surfacing (issue #52)', () => {
    const htmlWith = (listing: unknown) => {
      const data = { props: { listingRelation: { listing } } };
      return `<html><script>window.__INITIAL_DATA__ = ${JSON.stringify(data)};</script></html>`;
    };

    it('surfaces listing_agent { id, name } when agents[] is present', async () => {
      mockFetchHtml.mockResolvedValueOnce(
        htmlWith({
          listingIdSHA: 'a',
          pageLink: '/x/a_lid/',
          // Compass typically surfaces agents on the listing record;
          // the primary listing agent is the first entry.
          agents: [
            { id: 'agent-1', fullName: 'Jane Realtor', companyName: 'Compass NC' },
            { id: 'agent-2', fullName: 'Co Agent', companyName: 'Compass NC' },
          ],
        })
      );
      const r = await harness.callTool('compass_get_property', {
        url: '/x/a_lid/',
      });
      const parsed = parseToolResult<{
        listing_agent?: { id?: string; name?: string; brokerage?: string };
      }>(r);
      expect(parsed.listing_agent).toEqual({
        id: 'agent-1',
        name: 'Jane Realtor',
        brokerage: 'Compass NC',
      });
    });

    it('omits listing_agent when no agents[] is present', async () => {
      mockFetchHtml.mockResolvedValueOnce(
        htmlWith({ listingIdSHA: 'a', pageLink: '/x/a_lid/' })
      );
      const r = await harness.callTool('compass_get_property', {
        url: '/x/a_lid/',
      });
      const parsed = parseToolResult<{ listing_agent?: unknown }>(r);
      expect(parsed.listing_agent).toBeUndefined();
    });

    it('surfaces profile_slug + profile_url so callers can chain to compass_get_agent_listings (#52)', () => {
      // The listing-side agent record carries the agent's profile href
      // (`/agents/<slug>/`). Surfacing the slug + url lets a caller go
      // property → agent → their other listings.
      const out = format({
        listingIdSHA: 'a',
        pageLink: '/x/a_lid/',
        agents: [
          {
            id: 'agent-1',
            fullName: 'Paige McGuirk',
            companyName: 'Compass',
            profileUrl: '/agents/paige-mcguirk/',
          },
        ],
      });
      expect(out.listing_agent).toEqual({
        id: 'agent-1',
        name: 'Paige McGuirk',
        brokerage: 'Compass',
        profile_slug: 'paige-mcguirk',
        profile_url: 'https://www.compass.com/agents/paige-mcguirk/',
      });
    });

    it('normalizes an absolute agent profileUrl to slug + canonical url (#52)', () => {
      const out = format({
        listingIdSHA: 'a',
        pageLink: '/x/a_lid/',
        agents: [
          {
            id: 'agent-1',
            fullName: 'Paige McGuirk',
            profileUrl: 'https://www.compass.com/agents/paige-mcguirk/',
          },
        ],
      });
      expect(out.listing_agent?.profile_slug).toBe('paige-mcguirk');
      expect(out.listing_agent?.profile_url).toBe(
        'https://www.compass.com/agents/paige-mcguirk/'
      );
    });

    it('omits profile_slug/profile_url when the agent record has no profile href (#52)', () => {
      const out = format({
        listingIdSHA: 'a',
        pageLink: '/x/a_lid/',
        agents: [{ id: 'agent-1', fullName: 'No Profile' }],
      });
      expect(out.listing_agent).toEqual({
        id: 'agent-1',
        name: 'No Profile',
        brokerage: undefined,
      });
      expect(out.listing_agent?.profile_slug).toBeUndefined();
      expect(out.listing_agent?.profile_url).toBeUndefined();
    });

    it('omits profile_slug/profile_url (no throw) when the agent profileUrl is malformed (#52)', () => {
      // A non-/agents/ href that also fails slug validation must be swallowed
      // by the try/catch in format(): listing_agent still returns, just
      // without the chain fields — the whole property fetch must not fail.
      const out = format({
        listingIdSHA: 'a',
        pageLink: '/x/a_lid/',
        agents: [
          {
            id: 'agent-1',
            fullName: 'Bad Href',
            companyName: 'Compass',
            profileUrl: 'not a valid slug!!',
          },
        ],
      });
      expect(out.listing_agent).toEqual({
        id: 'agent-1',
        name: 'Bad Href',
        brokerage: 'Compass',
      });
      expect(out.listing_agent?.profile_slug).toBeUndefined();
      expect(out.listing_agent?.profile_url).toBeUndefined();
    });
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

    it('tax_annual nulls out the 0/1 not-yet-assessed sentinel + flags tax_status (#38)', async () => {
      mockFetchHtml.mockResolvedValueOnce(
        htmlWith({
          listingIdSHA: 'a',
          pageLink: '/x/a_lid/',
          detailedInfo: { taxAnnualAmount: 1 },
        })
      );
      const r = await harness.callTool('compass_get_property', { url: '/x/a_lid/' });
      const parsed = parseToolResult<{
        tax_annual?: number | null;
        tax_status?: string | null;
      }>(r);
      expect(parsed.tax_annual).toBeNull();
      expect(parsed.tax_status).toBe('not_yet_assessed');
    });

    it('tax_annual nulls a 2–9 figure as not_yet_assessed (canonical < 10 sentinel, realty-mcp#1)', async () => {
      // Behavior delta adopted from cohort `cleanTaxAnnual`: the old
      // inline `sanitizeTaxAnnual` only nulled `<= 1`, so a tax of 5
      // passed through. The canonical sentinel threshold is `< 10`.
      mockFetchHtml.mockResolvedValueOnce(
        htmlWith({
          listingIdSHA: 'a',
          pageLink: '/x/a_lid/',
          detailedInfo: { taxAnnualAmount: 5 },
        })
      );
      const r = await harness.callTool('compass_get_property', { url: '/x/a_lid/' });
      const parsed = parseToolResult<{
        tax_annual?: number | null;
        tax_status?: string | null;
      }>(r);
      expect(parsed.tax_annual).toBeNull();
      expect(parsed.tax_status).toBe('not_yet_assessed');
    });

    it('tax_annual passes through normal values with a null tax_status (#38)', async () => {
      mockFetchHtml.mockResolvedValueOnce(
        htmlWith({
          listingIdSHA: 'a',
          pageLink: '/x/a_lid/',
          detailedInfo: { taxAnnualAmount: 8200 },
        })
      );
      const r = await harness.callTool('compass_get_property', { url: '/x/a_lid/' });
      const parsed = parseToolResult<{
        tax_annual?: number | null;
        tax_status?: string | null;
      }>(r);
      expect(parsed.tax_annual).toBe(8200);
      expect(parsed.tax_status).toBeNull();
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

    it('price_drop_* are null on a price RISE, not a negative drop (canonical priceDrop, realty-mcp#1)', async () => {
      // Behavior delta adopted from cohort `priceDrop(previous, current)`:
      // the old inline gated only on `previous !== current`, so a price
      // rise produced a negative `price_drop_amount`. The canonical helper
      // returns null when the price didn't actually fall — correct for a
      // field named `price_drop_*`.
      mockFetchHtml.mockResolvedValueOnce(
        htmlWith({
          listingIdSHA: 'a',
          pageLink: '/x/a_lid/',
          price: { lastKnown: 520000 },
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
