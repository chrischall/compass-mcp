import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { CompassClient } from '../../src/client.js';
import {
  addressMatchesQuery,
  buildAddressQuery,
  extractPidFromNavigationPageLink,
  normalizeAddressForMatch,
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
  it('joins address + city + state + zip with spaces', () => {
    expect(
      buildAddressQuery({
        address: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      })
    ).toBe('126 Sleeping Bear Ln Lake Lure NC 28746');
  });

  it('omits missing optional fields gracefully', () => {
    expect(
      buildAddressQuery({ address: '126 Sleeping Bear Ln', state: 'NC' })
    ).toBe('126 Sleeping Bear Ln NC');
  });

  it('trims and collapses whitespace', () => {
    expect(
      buildAddressQuery({
        address: '  126   Sleeping  Bear Ln  ',
        zip: ' 28746 ',
      })
    ).toBe('126 Sleeping Bear Ln 28746');
  });
});

describe('normalizeAddressForMatch', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalizeAddressForMatch('126 Sleeping Bear Ln.')).toBe(
      '126 sleeping bear ln'
    );
    expect(normalizeAddressForMatch('  126   Sleeping Bear   Ln  ')).toBe(
      '126 sleeping bear ln'
    );
  });

  it('canonicalizes common street-type abbreviations', () => {
    // Compass tends to store full street types ("Lane", "Street") while
    // user queries use abbreviations ("Ln", "St"). Both should normalize
    // to the same canonical form.
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
  });
});

describe('addressMatchesQuery', () => {
  it('matches identical normalized addresses', () => {
    expect(
      addressMatchesQuery(
        '126 Sleeping Bear Ln, Lake Lure, NC 28746',
        { address: '126 Sleeping Bear Ln', city: 'Lake Lure', state: 'NC', zip: '28746' }
      )
    ).toBe(true);
  });

  it('matches across Lane vs Ln abbreviation', () => {
    expect(
      addressMatchesQuery(
        '126 Sleeping Bear Lane Lake Lure NC 28746',
        { address: '126 Sleeping Bear Ln', city: 'Lake Lure', state: 'NC' }
      )
    ).toBe(true);
  });

  it('rejects when street number differs', () => {
    expect(
      addressMatchesQuery(
        '999 Different St, Lake Lure, NC, 28746',
        { address: '126 Sleeping Bear Ln', city: 'Lake Lure', state: 'NC', zip: '28746' }
      )
    ).toBe(false);
  });

  it('CRITICAL: rejects the Charlotte-condo wrong-match (issue #45)', () => {
    expect(
      addressMatchesQuery(
        '1234 Tryon St #500, Charlotte, NC, 28202',
        { address: '126 Sleeping Bear Ln', city: 'Lake Lure', state: 'NC', zip: '28746' }
      )
    ).toBe(false);
  });

  it('returns false when candidate is empty/undefined', () => {
    expect(addressMatchesQuery('', { address: '126 Sleeping Bear Ln' })).toBe(false);
    expect(addressMatchesQuery(undefined, { address: '126 Sleeping Bear Ln' })).toBe(false);
  });
});

describe('extractPidFromNavigationPageLink', () => {
  it('pulls the pid out of /listing/<slug>/<pid>_pid/', () => {
    expect(
      extractPidFromNavigationPageLink('/listing/126-Sleeping-Bear-Ln/WNQQ8_pid/')
    ).toBe('WNQQ8');
  });

  it('pulls the pid out of /homedetails/<slug>/<pid>_pid/', () => {
    expect(
      extractPidFromNavigationPageLink('/homedetails/foo/203T5X_pid/')
    ).toBe('203T5X');
  });

  it('returns undefined when the path is not a _pid/ form', () => {
    expect(
      extractPidFromNavigationPageLink('/homedetails/foo/abc_lid/')
    ).toBeUndefined();
    expect(extractPidFromNavigationPageLink(undefined)).toBeUndefined();
    expect(extractPidFromNavigationPageLink('')).toBeUndefined();
  });
});

describe('compass_get_by_address tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerByAddressTools(server, mockClient)
    );
  });

  const searchHtml = (entries: unknown[]) => {
    const uc = {
      sharedReactAppProps: {
        initialResults: {
          lolResults: { totalItems: entries.length, data: entries },
        },
      },
    };
    return `<html><script>global.uc = ${JSON.stringify(uc)};</script></html>`;
  };

  it('searches by address and returns resolved url + listing_id_sha + pid', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      searchHtml([
        {
          listing: {
            listingIdSHA: '1887095624271872617',
            pageLink:
              '/homedetails/126-Sleeping-Bear-Ln-Lake-Lure-NC-28746/1887095624271872617_lid/',
            navigationPageLink:
              '/listing/126-Sleeping-Bear-Ln-Lake-Lure-NC-28746/WNQQ8_pid/',
            subtitles: ['126 Sleeping Bear Ln', 'Lake Lure'],
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
    // The address query is URL-encoded into /homes-for-sale/?q=...
    const calledPath = mockFetchHtml.mock.calls[0][0] as string;
    expect(calledPath).toMatch(/^\/homes-for-sale\/\?q=/);
    expect(decodeURIComponent(calledPath)).toContain(
      '126 Sleeping Bear Ln Lake Lure NC 28746'
    );
    const parsed = parseToolResult<{
      resolved: boolean;
      url: string;
      listing_id_sha: string;
      pid: string;
      address: string;
    }>(r);
    expect(parsed.resolved).toBe(true);
    expect(parsed.listing_id_sha).toBe('1887095624271872617');
    expect(parsed.pid).toBe('WNQQ8');
    // url should be the _pid/ form for stable referencing per issue #27.
    expect(parsed.url).toBe(
      'https://www.compass.com/listing/126-Sleeping-Bear-Ln-Lake-Lure-NC-28746/WNQQ8_pid/'
    );
    expect(parsed.address).toBe(
      '126 Sleeping Bear Ln, Lake Lure, NC 28746'
    );
  });

  it('returns resolved:false when the search has zero candidates', async () => {
    mockFetchHtml.mockResolvedValueOnce(searchHtml([]));
    const r = await harness.callTool('compass_get_by_address', {
      address: '999 Nowhere Rd',
      city: 'Atlantis',
      state: 'XX',
    });
    // Must not throw — the unified caller in issue #28 needs to degrade.
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{ resolved: boolean; error: string }>(r);
    expect(parsed.resolved).toBe(false);
    expect(parsed.error).toMatch(/no listing/i);
  });

  it('CRITICAL #45: returns resolved:false when top result is an unrelated property (silent-wrong-match regression)', async () => {
    // Real-world failure documented in issue #45:
    //   query: "126 Sleeping Bear Ln, Lake Lure, NC, 28746"
    //   pre-fix result: resolved:true with a Charlotte condo URL
    // Compass's `/homes-for-sale/?q=...` search degrades into a
    // far-away top hit when nothing in the local market matches, and
    // the tool was happily returning that hit. The fix: verify the
    // returned listing's address actually matches the query before
    // returning resolved:true.
    mockFetchHtml.mockResolvedValueOnce(
      searchHtml([
        {
          listing: {
            listingIdSHA: 'sha-charlotte-condo',
            pageLink:
              '/homedetails/1234-tryon-st-500-charlotte-nc-28202/sha-charlotte-condo_lid/',
            navigationPageLink:
              '/listing/1234-tryon-st-charlotte-nc-28202/ZZZ_pid/',
            // The candidate's subtitles disagree with the Lake Lure query.
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
      error?: string;
    }>(r);
    expect(parsed.resolved).toBe(false);
    expect(parsed.url).toBeUndefined();
    expect(parsed.error).toMatch(/no listing matched/i);
  });

  it('skips a non-matching first result but accepts a matching second result', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      searchHtml([
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
            pageLink:
              '/homedetails/126-Sleeping-Bear-Ln-Lake-Lure-NC-28746/sha-match_lid/',
            navigationPageLink:
              '/listing/126-Sleeping-Bear-Ln-Lake-Lure-NC-28746/WNQQ8_pid/',
            subtitles: ['126 Sleeping Bear Ln', 'Lake Lure, NC 28746'],
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
    const parsed = parseToolResult<{ resolved: boolean; listing_id_sha?: string }>(r);
    expect(parsed.resolved).toBe(true);
    expect(parsed.listing_id_sha).toBe('sha-match');
  });

  it('accepts a matching candidate across Lane vs Ln abbreviation', async () => {
    // Compass stores the full "Lane"; user typed "Ln". Verification
    // must normalize and accept.
    mockFetchHtml.mockResolvedValueOnce(
      searchHtml([
        {
          listing: {
            listingIdSHA: 'sha-lane',
            pageLink: '/homedetails/x/sha-lane_lid/',
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
    const parsed = parseToolResult<{ resolved: boolean }>(r);
    expect(parsed.resolved).toBe(true);
  });

  it('falls back to the _lid/ url when the listing has no navigationPageLink', async () => {
    // Some listings (per-listing edge cases) only carry pageLink. Still
    // resolved, but without a stable pid.
    mockFetchHtml.mockResolvedValueOnce(
      searchHtml([
        {
          listing: {
            listingIdSHA: 'abc',
            pageLink: '/homedetails/foo/abc_lid/',
            subtitles: ['1 Main', 'Foo'],
          },
        },
      ])
    );
    const r = await harness.callTool('compass_get_by_address', {
      address: '1 Main',
      city: 'Foo',
      state: 'XX',
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      resolved: boolean;
      url: string;
      pid?: string;
    }>(r);
    expect(parsed.resolved).toBe(true);
    expect(parsed.url).toBe(
      'https://www.compass.com/homedetails/foo/abc_lid/'
    );
    expect(parsed.pid).toBeUndefined();
  });
});
