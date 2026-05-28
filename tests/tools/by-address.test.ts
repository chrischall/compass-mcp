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

    it('page-walks slug results when first page has no match but second does', async () => {
      mockFetchHtml.mockResolvedValueOnce(searchHtml([])); // ?q= empty
      // Page 1: 5 entries, none match (full page → keep walking).
      const page1Entries = Array.from({ length: 5 }, (_, i) => ({
        listing: {
          listingIdSHA: `sha-p1-${i}`,
          pageLink: `/homedetails/p1-${i}/sha-p1-${i}_lid/`,
          subtitles: [`${i + 1} Other St`, 'Lake Lure, NC'],
        },
      }));
      mockFetchHtml.mockResolvedValueOnce(searchHtml(page1Entries));
      // Page 2: includes the match.
      mockFetchHtml.mockResolvedValueOnce(
        searchHtml([
          {
            listing: {
              listingIdSHA: 'sha-p2-hit',
              pageLink: '/homedetails/126-sleeping-bear-ln/sha-p2-hit_lid/',
              navigationPageLink: '/listing/126-sleeping-bear-ln/P2HIT_pid/',
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
      expect(parsed.listing_id_sha).toBe('sha-p2-hit');
      // ?q= + page 1 + page 2 = 3 fetches.
      expect(mockFetchHtml).toHaveBeenCalledTimes(3);
      // Page 2 must use Compass's /page-2/ canonical path segment.
      const page2Path = mockFetchHtml.mock.calls[2][0] as string;
      expect(page2Path).toContain('/page-2/');
    });

    it('stops slug page-walk when a short page signals exhaustion', async () => {
      mockFetchHtml.mockResolvedValueOnce(searchHtml([])); // ?q= empty
      // Short page (<COMPASS_PAGE_SIZE) → exhausted, no further fetch.
      mockFetchHtml.mockResolvedValueOnce(
        searchHtml([
          {
            listing: {
              listingIdSHA: 'sha-other',
              pageLink: '/homedetails/x/sha-other_lid/',
              subtitles: ['999 Other St', 'Lake Lure, NC'],
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
      expect(parsed.resolved).toBe(false);
      // Only 2 fetches: ?q= + one slug page; no /page-2/ because short.
      expect(mockFetchHtml).toHaveBeenCalledTimes(2);
    });
  });
});
