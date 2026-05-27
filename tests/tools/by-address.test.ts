import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { CompassClient } from '../../src/client.js';
import {
  buildAddressQuery,
  normalizeAddressForMatch,
  addressMatchesQuery,
  registerByAddressTools,
} from '../../src/tools/by-address.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as CompassClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

describe('buildAddressQuery', () => {
  it('joins parts with comma-space when all present', () => {
    expect(
      buildAddressQuery({
        address: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      })
    ).toBe('126 Sleeping Bear Ln, Lake Lure, NC, 28746');
  });

  it('omits absent optional parts', () => {
    expect(buildAddressQuery({ address: '126 Main St' })).toBe('126 Main St');
  });
});

describe('normalizeAddressForMatch', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalizeAddressForMatch('126 Sleeping Bear Ln.')).toBe(
      '126 sleeping bear ln'
    );
    expect(normalizeAddressForMatch('  126  Sleeping  Bear  Ln  ')).toBe(
      '126 sleeping bear ln'
    );
  });

  it('expands common street-type abbreviations to canonical form', () => {
    // We canonicalize to the abbreviation form because Compass tends to
    // store the long form ("Lane") while user queries use the short form
    // ("Ln"). Either input should normalize to the same string.
    expect(normalizeAddressForMatch('126 Sleeping Bear Lane')).toBe(
      normalizeAddressForMatch('126 Sleeping Bear Ln')
    );
    expect(normalizeAddressForMatch('500 Main Street')).toBe(
      normalizeAddressForMatch('500 Main St')
    );
    expect(normalizeAddressForMatch('1 Foo Avenue')).toBe(
      normalizeAddressForMatch('1 Foo Ave')
    );
    expect(normalizeAddressForMatch('1 Foo Drive')).toBe(
      normalizeAddressForMatch('1 Foo Dr')
    );
    expect(normalizeAddressForMatch('1 Foo Road')).toBe(
      normalizeAddressForMatch('1 Foo Rd')
    );
    expect(normalizeAddressForMatch('1 Foo Boulevard')).toBe(
      normalizeAddressForMatch('1 Foo Blvd')
    );
    expect(normalizeAddressForMatch('1 Foo Court')).toBe(
      normalizeAddressForMatch('1 Foo Ct')
    );
  });
});

describe('addressMatchesQuery', () => {
  it('matches identical addresses', () => {
    expect(
      addressMatchesQuery(
        '126 Sleeping Bear Ln, Lake Lure, NC, 28746',
        '126 Sleeping Bear Ln, Lake Lure, NC, 28746'
      )
    ).toBe(true);
  });

  it('matches across "Lane" vs "Ln" abbreviation', () => {
    expect(
      addressMatchesQuery(
        '126 Sleeping Bear Lane, Lake Lure, NC, 28746',
        '126 Sleeping Bear Ln'
      )
    ).toBe(true);
  });

  it('rejects when street number differs', () => {
    expect(
      addressMatchesQuery(
        '999 Different St, Lake Lure, NC, 28746',
        '126 Sleeping Bear Ln, Lake Lure, NC, 28746'
      )
    ).toBe(false);
  });

  it('rejects the silent-wrong-match case: query in NC resolves to a Charlotte condo', () => {
    // Regression for issue #45: previously the tool returned
    // resolved:true with the address echoed back unchanged BUT the URL
    // pointed at an unrelated Charlotte NC condo. addressMatchesQuery
    // is the gate.
    const queryAddress = '126 Sleeping Bear Ln, Lake Lure, NC, 28746';
    const wrongCandidate = '1234 Tryon St #500, Charlotte, NC, 28202';
    expect(addressMatchesQuery(wrongCandidate, queryAddress)).toBe(false);
  });

  it('returns false when candidate is empty', () => {
    expect(addressMatchesQuery('', '126 Sleeping Bear Ln')).toBe(false);
    expect(addressMatchesQuery(undefined, '126 Sleeping Bear Ln')).toBe(false);
  });
});

describe('compass_get_by_address tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerByAddressTools(server, mockClient)
    );
  });

  /**
   * Build a fake compass.com search-results HTML page with the given
   * raw listings. Mirrors `tests/tools/search.test.ts`.
   */
  const htmlWith = (listings: unknown[]): string => {
    const uc = {
      sharedReactAppProps: {
        initialResults: {
          lolResults: { totalItems: listings.length, data: listings },
        },
      },
    };
    return `<html><script>global.uc = ${JSON.stringify(uc)};</script></html>`;
  };

  it('resolves an address to the matching top listing url + listing_id', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWith([
        {
          listing: {
            listingIdSHA: 'sha-126',
            pageLink: '/homedetails/126-sleeping-bear-ln-lake-lure-nc-28746/sha-126_lid/',
            navigationPageLink: '/homedetails/126-sleeping-bear-ln-lake-lure-nc-28746/PID_pid/',
            title: '$2,498,000',
            subtitles: ['126 Sleeping Bear Lane', 'Lake Lure, NC 28746'],
          },
        },
      ])
    );
    const r = await harness.callTool('compass_get_by_address', {
      address: '126 Sleeping Bear Ln',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      resolved: boolean;
      url?: string;
      listing_id_sha?: string;
      address?: string;
      match_method?: string;
    }>(r);
    expect(parsed.resolved).toBe(true);
    expect(parsed.listing_id_sha).toBe('sha-126');
    expect(parsed.url).toContain('/homedetails/126-sleeping-bear-ln');
    expect(parsed.match_method).toBe('normalized');
  });

  it('CRITICAL: returns resolved:false when search top hit is an unrelated property (silent-wrong-match regression)', async () => {
    // Compass's slugify of "126 Sleeping Bear Ln, Lake Lure, NC, 28746"
    // can produce an empty zone that the search route degrades into a
    // far-away top hit (the Charlotte condo from the bug report).
    // Pre-fix, the tool returned resolved:true with that URL. Now it
    // must inspect candidate addresses and reject.
    mockFetchHtml.mockResolvedValueOnce(
      htmlWith([
        {
          listing: {
            listingIdSHA: 'sha-charlotte',
            pageLink: '/homedetails/1234-tryon-st-charlotte-nc-28202/sha-charlotte_lid/',
            title: '$500,000',
            // Note: different street, different city.
            subtitles: ['1234 Tryon St #500', 'Charlotte, NC 28202'],
          },
        },
      ])
    );
    const r = await harness.callTool('compass_get_by_address', {
      address: '126 Sleeping Bear Ln',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      resolved: boolean;
      url?: string;
      query?: string;
      error?: string;
    }>(r);
    expect(parsed.resolved).toBe(false);
    expect(parsed.url).toBeUndefined();
    expect(parsed.query).toBe('126 Sleeping Bear Ln, Lake Lure, NC, 28746');
    expect(parsed.error).toMatch(/no listing matched/i);
  });

  it('returns resolved:false when search has zero results', async () => {
    mockFetchHtml.mockResolvedValueOnce(htmlWith([]));
    const r = await harness.callTool('compass_get_by_address', {
      address: '999 Nowhere Rd',
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{ resolved: boolean; error?: string }>(r);
    expect(parsed.resolved).toBe(false);
    expect(parsed.error).toMatch(/no listing/i);
  });

  it('picks the matching listing even when it is not the first', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWith([
        {
          listing: {
            listingIdSHA: 'sha-noise',
            pageLink: '/homedetails/999-noise-st-asheville-nc/sha-noise_lid/',
            subtitles: ['999 Noise St', 'Asheville, NC'],
          },
        },
        {
          listing: {
            listingIdSHA: 'sha-match',
            pageLink: '/homedetails/126-sleeping-bear-ln-lake-lure-nc-28746/sha-match_lid/',
            subtitles: ['126 Sleeping Bear Lane', 'Lake Lure, NC 28746'],
          },
        },
      ])
    );
    const r = await harness.callTool('compass_get_by_address', {
      address: '126 Sleeping Bear Ln',
      city: 'Lake Lure',
      state: 'NC',
    });
    const parsed = parseToolResult<{ resolved: boolean; listing_id_sha?: string }>(r);
    expect(parsed.resolved).toBe(true);
    expect(parsed.listing_id_sha).toBe('sha-match');
  });
});
