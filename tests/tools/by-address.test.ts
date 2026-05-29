import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { CompassClient } from '../../src/client.js';
import {
  addressMatchesQuery,
  buildAddressQuery,
  buildListingUrl,
  compassListingUrl,
  normalizeAddressForMatch,
  registerByAddressTools,
} from '../../src/tools/by-address.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockFetchJson = vi.fn();
const mockClient = {
  fetchHtml: mockFetchHtml,
  fetchJson: mockFetchJson,
} as unknown as CompassClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => {
  vi.clearAllMocks();
  // Default: the structured typeahead rung returns no candidates, so
  // tests that exercise the SSR fallback rungs keep their existing
  // assertions. Per-test overrides drive the typeahead rung.
  mockFetchJson.mockResolvedValue({ categories: [] });
});
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

  // Issue #55 review: substring vs. whole-token matching.
  // `cand.includes(t)` lets a short query number/token match inside a
  // longer candidate token (e.g. "12" inside "1234", "Lee" inside
  // "Leesburg"). Both branches must use whole-token equality.
  it('rejects when street number is a prefix of a different number', () => {
    // Query "12 Oak St" must NOT match candidate "1234 Oak St".
    expect(
      addressMatchesQuery('1234 Oak St, Dallas, TX', {
        address: '12 Oak St',
        city: 'Dallas',
      })
    ).toBe(false);
  });

  it('rejects when street number is a prefix and city matches', () => {
    // The numeric-prefix collision must lose even when city matches.
    expect(
      addressMatchesQuery('512 Main Rd, Springfield, IL', {
        address: '5 Main Rd',
        city: 'Springfield',
      })
    ).toBe(false);
  });

  it('rejects when city name is a substring of a different city', () => {
    // Query city "Lee" must NOT match candidate city "Leesburg".
    expect(
      addressMatchesQuery('126 Sleeping Bear Ln, Leesburg, VA', {
        address: '126 Sleeping Bear Ln',
        city: 'Lee',
      })
    ).toBe(false);
  });
});

describe('compassListingUrl (deduped URL ladder)', () => {
  const listing = {
    listingIdSHA: 'abc',
    pageLink: '/homedetails/foo/abc_lid/',
    navigationPageLink: '/listing/foo/WNQQ8_pid/',
  };

  it('default prefers the stable _pid/ navigationPageLink (issue #27)', () => {
    expect(compassListingUrl(listing)).toBe(
      'https://www.compass.com/listing/foo/WNQQ8_pid/'
    );
    // buildListingUrl is a thin alias of the pid-preferring ladder.
    expect(buildListingUrl(listing)).toBe(compassListingUrl(listing));
  });

  it("prefer:'pageLink' prefers the slugged _lid/ pageLink (issue #15)", () => {
    expect(compassListingUrl(listing, { prefer: 'pageLink' })).toBe(
      'https://www.compass.com/homedetails/foo/abc_lid/'
    );
  });

  it('falls back to pageLink when navigationPageLink is absent (pid preference)', () => {
    expect(
      compassListingUrl({ listingIdSHA: 'abc', pageLink: '/homedetails/foo/abc_lid/' })
    ).toBe('https://www.compass.com/homedetails/foo/abc_lid/');
  });

  it('falls back to the slug-less _lid/ form when no links are present', () => {
    expect(compassListingUrl({ listingIdSHA: 'abc' })).toBe(
      'https://www.compass.com/homedetails/abc_lid/'
    );
  });

  it('passes an already-absolute link through unchanged', () => {
    expect(
      compassListingUrl(
        { pageLink: 'https://www.compass.com/homedetails/foo/abc_lid/' },
        { prefer: 'pageLink' }
      )
    ).toBe('https://www.compass.com/homedetails/foo/abc_lid/');
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

  // Build an omnisuggest autocomplete response (the structured rung).
  const omnisuggest = (
    items: Array<{ text: string; subText: string; id: string }>
  ) => ({
    categories: [{ name: 1, label: 'Addresses', items }],
    success: true,
  });

  describe('#78/#79 structured typeahead rung (primary)', () => {
    it('resolves via the autocomplete endpoint before any SSR fetch', async () => {
      mockFetchJson.mockResolvedValueOnce(
        omnisuggest([
          {
            text: '126 Sleeping Bear Ln',
            subText: 'Lake Lure, NC',
            id: '1887095624271872617',
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
        url: string;
        listing_id_sha: string;
        matched_via: string;
      }>(r);
      expect(parsed.resolved).toBe(true);
      expect(parsed.matched_via).toBe('typeahead');
      expect(parsed.listing_id_sha).toBe('1887095624271872617');
      // _lid/ URL built from the candidate id (no _pid/ in autocomplete).
      expect(parsed.url).toBe(
        'https://www.compass.com/homedetails/1887095624271872617_lid/'
      );
      // The structured rung short-circuits the SSR rungs entirely.
      expect(mockFetchHtml).not.toHaveBeenCalled();
      // It POSTed to the omnisuggest endpoint.
      const [calledPath] = mockFetchJson.mock.calls[0];
      expect(calledPath).toBe('/api/v3/omnisuggest/autocomplete');
    });

    it('CRITICAL #78: resolves 158 Raven Blvd to its _lid/ URL', async () => {
      // Real false-negative from the field report — the SSR ?q= rung is
      // WAF-blocked, so this MUST resolve through the structured rung.
      mockFetchJson.mockResolvedValueOnce(
        omnisuggest([
          {
            text: '158 Raven Blvd',
            subText: 'Lake Lure, NC',
            id: '2029026490125049409',
          },
        ])
      );
      const r = await harness.callTool('compass_get_by_address', {
        address: '158 Raven Blvd',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      const parsed = parseToolResult<{
        resolved: boolean;
        url: string;
        listing_id_sha: string;
        matched_via: string;
      }>(r);
      expect(parsed.resolved).toBe(true);
      expect(parsed.matched_via).toBe('typeahead');
      expect(parsed.listing_id_sha).toBe('2029026490125049409');
      expect(parsed.url).toBe(
        'https://www.compass.com/homedetails/2029026490125049409_lid/'
      );
    });

    it('CRITICAL #78: resolves 155 Quail Cove Blvd Unit 1601 to the matching unit', async () => {
      // Multi-unit building — autocomplete returns several units. The
      // #45 whole-token verifier must pick the one carrying the "1601"
      // unit token, not the first candidate.
      mockFetchJson.mockResolvedValueOnce(
        omnisuggest([
          {
            text: '155 Quail Cove Blvd, Unit 1602',
            subText: 'Lake Lure, NC',
            id: '1745067614490786889',
          },
          {
            text: '155 Quail Cove Blvd, Unit 1601',
            subText: 'Lake Lure, NC',
            id: '2079951245069150641',
          },
        ])
      );
      const r = await harness.callTool('compass_get_by_address', {
        address: '155 Quail Cove Blvd Unit 1601',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      const parsed = parseToolResult<{
        resolved: boolean;
        listing_id_sha: string;
        matched_via: string;
        url: string;
      }>(r);
      expect(parsed.resolved).toBe(true);
      expect(parsed.matched_via).toBe('typeahead');
      expect(parsed.listing_id_sha).toBe('2079951245069150641');
      expect(parsed.url).toBe(
        'https://www.compass.com/homedetails/2079951245069150641_lid/'
      );
    });

    it('CRITICAL #45: rejects a non-matching autocomplete candidate (no silent wrong-match)', async () => {
      // Even if the typeahead returns a far-away candidate, the
      // whole-token verifier must reject it rather than leak the URL.
      mockFetchJson.mockResolvedValueOnce(
        omnisuggest([
          {
            text: '1234 Tryon St, Unit 500',
            subText: 'Charlotte, NC',
            id: 'sha-charlotte-condo',
          },
        ])
      );
      // No SSR fallback match either.
      mockFetchHtml.mockResolvedValue(searchHtml([]));
      const r = await harness.callTool('compass_get_by_address', {
        address: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      const parsed = parseToolResult<{
        resolved: boolean;
        url?: string;
        error?: string;
      }>(r);
      expect(parsed.resolved).toBe(false);
      expect(parsed.url).toBeUndefined();
      expect(parsed.error).toMatch(/no listing matched/i);
    });

    it('falls through to the SSR rungs when the autocomplete throws (WAF/transport fault)', async () => {
      // If the structured rung fails for any reason, the resolver must
      // degrade to the legacy SSR rungs rather than error out.
      mockFetchJson.mockRejectedValueOnce(new Error('omnisuggest 403'));
      mockFetchHtml.mockResolvedValueOnce(
        searchHtml([
          {
            listing: {
              listingIdSHA: 'sha-ssr',
              pageLink: '/homedetails/126-sleeping-bear-ln/sha-ssr_lid/',
              navigationPageLink: '/listing/126-sleeping-bear-ln/SSRPID_pid/',
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
      const parsed = parseToolResult<{
        resolved: boolean;
        matched_via: string;
        listing_id_sha: string;
      }>(r);
      expect(parsed.resolved).toBe(true);
      // SSR ?q= rung carried it after the structured rung threw.
      expect(parsed.matched_via).toBe('freetext');
      expect(parsed.listing_id_sha).toBe('sha-ssr');
    });

    it('falls through to the SSR rungs when autocomplete returns zero candidates', async () => {
      mockFetchJson.mockResolvedValueOnce({ categories: [] });
      mockFetchHtml.mockResolvedValueOnce(
        searchHtml([
          {
            listing: {
              listingIdSHA: 'sha-ssr2',
              pageLink: '/homedetails/x/sha-ssr2_lid/',
              subtitles: ['126 Sleeping Bear Ln', 'Lake Lure, NC 28746'],
            },
          },
        ])
      );
      const r = await harness.callTool('compass_get_by_address', {
        address: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
        state: 'NC',
      });
      const parsed = parseToolResult<{
        resolved: boolean;
        matched_via: string;
      }>(r);
      expect(parsed.resolved).toBe(true);
      expect(parsed.matched_via).toBe('freetext');
    });
  });

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

  describe('matched_via surfacing (issue #71)', () => {
    it('surfaces matched_via: "freetext" when the ?q= rung matches', async () => {
      mockFetchHtml.mockResolvedValueOnce(
        searchHtml([
          {
            listing: {
              listingIdSHA: 'sha-freetext',
              pageLink: '/homedetails/126-sleeping-bear-ln/sha-freetext_lid/',
              navigationPageLink: '/listing/126-sleeping-bear-ln/PIDFT_pid/',
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
      const parsed = parseToolResult<{
        resolved: boolean;
        matched_via?: string;
      }>(r);
      expect(parsed.resolved).toBe(true);
      expect(parsed.matched_via).toBe('freetext');
      // Only one fetch — no fallback needed.
      expect(mockFetchHtml).toHaveBeenCalledTimes(1);
    });
  });

  describe('#71 search-fallback rung', () => {
    it('falls through to slug-based search when ?q= returns no candidates', async () => {
      // First call: the ?q= rung returns empty.
      mockFetchHtml.mockResolvedValueOnce(searchHtml([]));
      // Second call: the slug-based search returns 1 hit that matches.
      mockFetchHtml.mockResolvedValueOnce(
        searchHtml([
          {
            listing: {
              listingIdSHA: 'sha-fallback',
              pageLink: '/homedetails/126-sleeping-bear-ln-lake-lure-nc/sha-fallback_lid/',
              navigationPageLink: '/listing/126-sleeping-bear-ln-lake-lure-nc/PIDFB_pid/',
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
      const parsed = parseToolResult<{
        resolved: boolean;
        matched_via?: string;
        listing_id_sha?: string;
        pid?: string;
      }>(r);
      expect(parsed.resolved).toBe(true);
      expect(parsed.matched_via).toBe('search_fallback');
      expect(parsed.listing_id_sha).toBe('sha-fallback');
      expect(parsed.pid).toBe('PIDFB');
      // The second call must hit a slug-based search path, not ?q=.
      expect(mockFetchHtml).toHaveBeenCalledTimes(2);
      const fallbackPath = mockFetchHtml.mock.calls[1][0] as string;
      expect(fallbackPath).toMatch(/^\/homes-for-sale\/[a-z0-9-]+\/?$/);
      expect(fallbackPath).not.toContain('?q=');
    });

    it('falls back to slug search when ?q= returns non-matching candidates (#45 + #71)', async () => {
      // ?q= rung degrades into a Charlotte condo top hit — the address
      // verifier rejects it, then we fall through to the slug rung,
      // which carries the correct listing.
      mockFetchHtml.mockResolvedValueOnce(
        searchHtml([
          {
            listing: {
              listingIdSHA: 'sha-charlotte',
              pageLink: '/homedetails/1234-tryon-st-charlotte-nc/sha-charlotte_lid/',
              subtitles: ['1234 Tryon St #500', 'Charlotte, NC 28202'],
            },
          },
        ])
      );
      mockFetchHtml.mockResolvedValueOnce(
        searchHtml([
          {
            listing: {
              listingIdSHA: 'sha-slug-match',
              pageLink: '/homedetails/126-sleeping-bear-ln/sha-slug-match_lid/',
              navigationPageLink: '/listing/126-sleeping-bear-ln/SLUGPID_pid/',
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
      const parsed = parseToolResult<{
        resolved: boolean;
        matched_via?: string;
        listing_id_sha?: string;
      }>(r);
      expect(parsed.resolved).toBe(true);
      expect(parsed.matched_via).toBe('search_fallback');
      expect(parsed.listing_id_sha).toBe('sha-slug-match');
    });

    it('uses {city, state} slug when both are present', async () => {
      mockFetchHtml.mockResolvedValueOnce(searchHtml([]));
      mockFetchHtml.mockResolvedValueOnce(searchHtml([]));
      await harness.callTool('compass_get_by_address', {
        address: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      const fallbackPath = mockFetchHtml.mock.calls[1][0] as string;
      // locationToSlug("Lake Lure, NC") → "lake-lure-nc"
      expect(fallbackPath).toContain('/homes-for-sale/lake-lure-nc/');
    });

    it('falls back to ZIP-only slug when city is missing', async () => {
      mockFetchHtml.mockResolvedValueOnce(searchHtml([]));
      mockFetchHtml.mockResolvedValueOnce(searchHtml([]));
      await harness.callTool('compass_get_by_address', {
        address: '999 Far Out Rd',
        state: 'NC',
        zip: '28746',
      });
      const fallbackPath = mockFetchHtml.mock.calls[1][0] as string;
      expect(fallbackPath).toContain('/homes-for-sale/28746/');
    });

    it('returns resolved:false when neither rung matches', async () => {
      mockFetchHtml.mockResolvedValueOnce(searchHtml([]));
      mockFetchHtml.mockResolvedValueOnce(
        searchHtml([
          {
            listing: {
              listingIdSHA: 'sha-wrong',
              pageLink: '/homedetails/wrong/sha-wrong_lid/',
              subtitles: ['100 Unrelated St', 'Lake Lure, NC 28746'],
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
      const parsed = parseToolResult<{
        resolved: boolean;
        error?: string;
      }>(r);
      expect(parsed.resolved).toBe(false);
      expect(parsed.error).toMatch(/no listing matched/i);
    });

    it('skips the slug rung when there is no locality to slugify', async () => {
      // Bare address with no city/state/zip — slug rung has nothing to
      // anchor on, so we don't fan out.
      mockFetchHtml.mockResolvedValueOnce(searchHtml([]));
      const r = await harness.callTool('compass_get_by_address', {
        address: '126 Sleeping Bear Ln',
      });
      const parsed = parseToolResult<{ resolved: boolean }>(r);
      expect(parsed.resolved).toBe(false);
      // Only the ?q= rung fires.
      expect(mockFetchHtml).toHaveBeenCalledTimes(1);
    });

    it('skips the slug rung when only state is supplied (too broad)', async () => {
      // State-only locality would slug to a state-wide page-walk
      // (e.g. /homes-for-sale/nc/) — too broad for the verifier's
      // street-token-only guard. PR description says fallback is
      // skipped when no usable locality is supplied; treat bare
      // state the same as bare address.
      mockFetchHtml.mockResolvedValueOnce(searchHtml([]));
      const r = await harness.callTool('compass_get_by_address', {
        address: '126 Sleeping Bear Ln',
        state: 'NC',
      });
      const parsed = parseToolResult<{ resolved: boolean }>(r);
      expect(parsed.resolved).toBe(false);
      // Only the ?q= rung fires — no state-wide fan-out.
      expect(mockFetchHtml).toHaveBeenCalledTimes(1);
    });

    it('CRITICAL #45 parity: slug rung honors whole-token equality (rejects prefix collisions)', async () => {
      mockFetchHtml.mockResolvedValueOnce(searchHtml([])); // ?q= empty
      mockFetchHtml.mockResolvedValueOnce(
        searchHtml([
          {
            listing: {
              listingIdSHA: 'sha-prefix-slug',
              pageLink: '/homedetails/1234-oak-st-dallas-tx/sha-prefix-slug_lid/',
              subtitles: ['1234 Oak St', 'Dallas, TX'],
            },
          },
        ])
      );
      const r = await harness.callTool('compass_get_by_address', {
        address: '12 Oak St',
        city: 'Dallas',
        state: 'TX',
      });
      const parsed = parseToolResult<{
        resolved: boolean;
        url?: string;
      }>(r);
      // "12 Oak St" must NOT match "1234 Oak St" — the #45 whole-token
      // guard must hold on the fallback rung just like on rung 1.
      expect(parsed.resolved).toBe(false);
      expect(parsed.url).toBeUndefined();
    });

    it('matches within the single reachable slug page (#87: /page-N/ is dead)', async () => {
      // Issue #87: Compass's `/page-N/` SSR path canonicalizes back to
      // page 1 and returns identical data, so the slug rung fetches page
      // 1 only — its ~41 listings are the entire reachable set. A match
      // anywhere in that page resolves; no /page-N/ walk.
      mockFetchHtml.mockResolvedValueOnce(searchHtml([])); // ?q= empty
      const page1Entries = [
        ...Array.from({ length: 5 }, (_, i) => ({
          listing: {
            listingIdSHA: `sha-p1-${i}`,
            pageLink: `/homedetails/p1-${i}/sha-p1-${i}_lid/`,
            subtitles: [`${i + 1} Other St`, 'Lake Lure, NC'],
          },
        })),
        {
          listing: {
            listingIdSHA: 'sha-hit',
            pageLink: '/homedetails/126-sleeping-bear-ln/sha-hit_lid/',
            navigationPageLink: '/listing/126-sleeping-bear-ln/HITPID_pid/',
            subtitles: ['126 Sleeping Bear Ln', 'Lake Lure, NC 28746'],
          },
        },
      ];
      mockFetchHtml.mockResolvedValueOnce(searchHtml(page1Entries));
      const r = await harness.callTool('compass_get_by_address', {
        address: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      const parsed = parseToolResult<{
        resolved: boolean;
        matched_via?: string;
        listing_id_sha?: string;
      }>(r);
      expect(parsed.resolved).toBe(true);
      expect(parsed.matched_via).toBe('search_fallback');
      expect(parsed.listing_id_sha).toBe('sha-hit');
      // ?q= + a single slug page = 2 fetches; NO /page-N/ walk.
      expect(mockFetchHtml).toHaveBeenCalledTimes(2);
      const slugPath = mockFetchHtml.mock.calls[1][0] as string;
      expect(slugPath).not.toContain('/page-');
    });

    it('does not page-walk: a miss on the single slug page is final (#87)', async () => {
      mockFetchHtml.mockResolvedValueOnce(searchHtml([])); // ?q= empty
      // The single reachable slug page has no match → resolved:false,
      // no /page-2/ fetch (it would just re-return this same page).
      mockFetchHtml.mockResolvedValueOnce(
        searchHtml(
          Array.from({ length: 41 }, (_, i) => ({
            listing: {
              listingIdSHA: `sha-other-${i}`,
              pageLink: `/homedetails/x-${i}/sha-other-${i}_lid/`,
              subtitles: [`${i + 1} Other St`, 'Lake Lure, NC'],
            },
          }))
        )
      );
      const r = await harness.callTool('compass_get_by_address', {
        address: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      const parsed = parseToolResult<{ resolved: boolean }>(r);
      expect(parsed.resolved).toBe(false);
      // Only 2 fetches: ?q= + one slug page; never a /page-2/.
      expect(mockFetchHtml).toHaveBeenCalledTimes(2);
    });
  });

  // Issue #86 (P1-2): the search-backed locality rung must be FIRST-CLASS
  // — it has far better recall than typeahead, so a typeahead miss/empty
  // must reach it. In production the intervening free-text `?q=` rung
  // hits the AWS WAF and *throws* (403 / sign-in interstitial); that
  // exception was aborting the whole resolve before the high-recall slug
  // rung ever ran. A content failure on the free-text rung must fall
  // through to the slug search, not error out.
  describe('#86 search-fallback is reachable when free-text rung errors (WAF)', () => {
    it('CRITICAL: a WAF 403 on the ?q= rung falls through to the slug search', async () => {
      // typeahead empty (default), ?q= throws (WAF), slug search matches.
      mockFetchHtml.mockImplementation(async (path: string) => {
        if (path.startsWith('/homes-for-sale/?q=')) {
          throw new Error('Compass API error: 403 for GET /homes-for-sale/?q=...');
        }
        // slug rung
        return searchHtml([
          {
            listing: {
              listingIdSHA: 'sha-recall',
              pageLink: '/homedetails/126-sleeping-bear-ln/sha-recall_lid/',
              navigationPageLink: '/listing/126-sleeping-bear-ln/RECALLPID_pid/',
              subtitles: ['126 Sleeping Bear Ln', 'Lake Lure, NC 28746'],
            },
          },
        ]);
      });
      const r = await harness.callTool('compass_get_by_address', {
        address: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      expect(r.isError).toBeFalsy();
      const parsed = parseToolResult<{
        resolved: boolean;
        matched_via?: string;
        listing_id_sha?: string;
      }>(r);
      expect(parsed.resolved).toBe(true);
      expect(parsed.matched_via).toBe('search_fallback');
      expect(parsed.listing_id_sha).toBe('sha-recall');
    });

    it('a sign-in interstitial on the ?q= rung still falls through to the slug search', async () => {
      mockFetchHtml.mockImplementation(async (path: string) => {
        if (path.startsWith('/homes-for-sale/?q=')) {
          throw new Error(
            'Not signed in to Compass. Open compass.com in your browser and sign in, then try again.'
          );
        }
        return searchHtml([
          {
            listing: {
              listingIdSHA: 'sha-recall-2',
              pageLink: '/homedetails/126-sleeping-bear-ln/sha-recall-2_lid/',
              subtitles: ['126 Sleeping Bear Ln', 'Lake Lure, NC 28746'],
            },
          },
        ]);
      });
      const r = await harness.callTool('compass_get_by_address', {
        address: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      });
      const parsed = parseToolResult<{ resolved: boolean; matched_via?: string }>(r);
      expect(parsed.resolved).toBe(true);
      expect(parsed.matched_via).toBe('search_fallback');
    });

    it('a transport timeout on the ?q= rung still PROPAGATES (not swallowed as fall-through)', async () => {
      // #85 boundary: a content failure (WAF) falls through, but a
      // transport timeout must NOT be silently downgraded — it has to
      // reach the per-row classifier so the resolver can report a
      // retryable status instead of a false miss.
      const { FetchproxyTimeoutError } = await import('@fetchproxy/server');
      mockFetchHtml.mockImplementation(async (path: string) => {
        if (path.startsWith('/homes-for-sale/?q=')) {
          throw new FetchproxyTimeoutError({
            url: 'https://www.compass.com/homes-for-sale/?q=...',
            timeoutMs: 25,
            elapsedMs: 28,
            role: 'peer',
            port: 37200,
          });
        }
        return searchHtml([]);
      });
      const r = await harness.callTool('compass_get_by_address', {
        address: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
        state: 'NC',
      });
      // Single tool surfaces the transport error rather than a false miss.
      expect(r.isError).toBeTruthy();
      const text = (r.content[0] as { text: string }).text;
      expect(text).toMatch(/timeout|did not respond/i);
    });

    it('still returns resolved:false when ?q= errors AND the slug rung genuinely has no match', async () => {
      mockFetchHtml.mockImplementation(async (path: string) => {
        if (path.startsWith('/homes-for-sale/?q=')) {
          throw new Error('Compass API error: 403 for GET /homes-for-sale/?q=...');
        }
        return searchHtml([]); // slug rung: genuine miss
      });
      const r = await harness.callTool('compass_get_by_address', {
        address: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
        state: 'NC',
      });
      const parsed = parseToolResult<{ resolved: boolean; error?: string }>(r);
      expect(parsed.resolved).toBe(false);
      expect(parsed.error).toMatch(/no listing matched/i);
    });
  });
});
