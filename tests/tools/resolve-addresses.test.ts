import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { FetchproxyTimeoutError } from '@fetchproxy/server';
import type { CompassClient } from '../../src/client.js';
import { registerResolveAddressesTools } from '../../src/tools/resolve-addresses.js';
import { registerByAddressTools } from '../../src/tools/by-address.js';
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
  // Default: structured typeahead rung returns no candidates so the
  // existing SSR-rung fixtures stay in control. Per-test overrides
  // drive the typeahead rung.
  mockFetchJson.mockResolvedValue({ categories: [] });
});

const omnisuggest = (
  items: Array<{ text: string; subText: string; id: string }>
) => ({ categories: [{ name: 1, label: 'Addresses', items }], success: true });
afterAll(async () => {
  if (harness) await harness.close();
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

describe('compass_resolve_addresses tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerResolveAddressesTools(server, mockClient)
    );
  });

  it('resolves each address concurrently, returning one row per input', async () => {
    mockFetchHtml.mockImplementation(async (path: string) => {
      // Pull the query from the path and surface a matching candidate.
      const m = /q=([^&]+)/.exec(path);
      const q = m ? decodeURIComponent(m[1]) : '';
      if (q.includes('126 Sleeping Bear')) {
        return searchHtml([
          {
            listing: {
              listingIdSHA: 'sha-1',
              pageLink: '/homedetails/126-Sleeping-Bear-Ln-Lake-Lure-NC-28746/sha-1_lid/',
              navigationPageLink: '/listing/126-Sleeping-Bear-Ln/PID1_pid/',
              subtitles: ['126 Sleeping Bear Ln', 'Lake Lure'],
            },
          },
        ]);
      }
      if (q.includes('500 Main')) {
        return searchHtml([
          {
            listing: {
              listingIdSHA: 'sha-2',
              pageLink: '/homedetails/500-Main-St-Asheville-NC/sha-2_lid/',
              subtitles: ['500 Main St', 'Asheville'],
            },
          },
        ]);
      }
      return searchHtml([]);
    });

    const r = await harness.callTool('compass_resolve_addresses', {
      addresses: [
        { address: '126 Sleeping Bear Ln', city: 'Lake Lure', state: 'NC' },
        { address: '500 Main St', city: 'Asheville', state: 'NC' },
        { address: '999 Nowhere Rd', state: 'XX' },
      ],
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      count: number;
      rows: Array<{
        resolved: boolean;
        url?: string;
        listing_id_sha?: string;
        pid?: string;
        error?: string;
      }>;
    }>(r);
    expect(parsed.count).toBe(3);
    expect(parsed.rows[0].resolved).toBe(true);
    expect(parsed.rows[0].listing_id_sha).toBe('sha-1');
    expect(parsed.rows[0].pid).toBe('PID1');
    expect(parsed.rows[1].resolved).toBe(true);
    expect(parsed.rows[1].listing_id_sha).toBe('sha-2');
    expect(parsed.rows[2].resolved).toBe(false);
    expect(parsed.rows[2].url).toBeUndefined();
    expect(parsed.rows[2].error).toMatch(/no listing/i);
  });

  it('CRITICAL #45/#46: per-row honesty — never returns a wrong URL on a miss', async () => {
    // Reuses the silent-wrong-match guarantee from compass_get_by_address.
    // Bulk amplifies the corruption surface, so each row independently
    // verifies the candidate's address against the query.
    mockFetchHtml.mockResolvedValue(
      searchHtml([
        {
          listing: {
            listingIdSHA: 'sha-charlotte',
            pageLink: '/homedetails/1234-tryon-st-charlotte-nc/sha-charlotte_lid/',
            subtitles: ['1234 Tryon St', 'Charlotte, NC'],
          },
        },
      ])
    );
    const r = await harness.callTool('compass_resolve_addresses', {
      addresses: [
        { address: '126 Sleeping Bear Ln', city: 'Lake Lure', state: 'NC', zip: '28746' },
      ],
    });
    const parsed = parseToolResult<{
      rows: Array<{ resolved: boolean; url?: string; error?: string }>;
    }>(r);
    expect(parsed.rows[0].resolved).toBe(false);
    expect(parsed.rows[0].url).toBeUndefined();
  });

  it('captures per-row errors without failing the whole call', async () => {
    let n = 0;
    mockFetchHtml.mockImplementation(async () => {
      n++;
      if (n === 2) throw new Error('upstream fault');
      return searchHtml([
        {
          listing: {
            listingIdSHA: `sha-${n}`,
            pageLink: `/homedetails/${n}-main/sha-${n}_lid/`,
            subtitles: [`${n} Main`, 'X, NY'],
          },
        },
      ]);
    });
    const r = await harness.callTool('compass_resolve_addresses', {
      addresses: [
        { address: '1 Main', city: 'X', state: 'NY' },
        { address: '2 Main', city: 'X', state: 'NY' },
        { address: '3 Main', city: 'X', state: 'NY' },
      ],
    });
    const parsed = parseToolResult<{
      rows: Array<{ resolved: boolean; error?: string }>;
    }>(r);
    expect(parsed.rows[0].resolved).toBe(true);
    expect(parsed.rows[1].resolved).toBe(false);
    expect(parsed.rows[1].error).toMatch(/upstream fault/);
    expect(parsed.rows[2].resolved).toBe(true);
  });

  it('retries once on FetchproxyTimeoutError before committing to resolved:false', async () => {
    // Parity with bulk-get / compare: a single bridge timeout on a
    // stale rotating tab usually succeeds on the second attempt. The
    // `retryOnceOnTimeout` wrapper must fire BEFORE the per-row catch
    // would otherwise turn the timeout into `resolved: false`, or the
    // wrapper is a no-op.
    let attempts = 0;
    mockFetchHtml.mockImplementation(async () => {
      attempts++;
      if (attempts === 1) {
        throw new FetchproxyTimeoutError({
          url: 'https://www.compass.com/homes-for-sale/?q=...',
          timeoutMs: 25,
          elapsedMs: 28,
          role: 'peer',
          port: 37200,
        });
      }
      return searchHtml([
        {
          listing: {
            listingIdSHA: 'sha-retry',
            pageLink: '/homedetails/126-sleeping-bear-ln/sha-retry_lid/',
            subtitles: ['126 Sleeping Bear Ln', 'Lake Lure, NC 28746'],
          },
        },
      ]);
    });

    const r = await harness.callTool('compass_resolve_addresses', {
      addresses: [
        { address: '126 Sleeping Bear Ln', city: 'Lake Lure', state: 'NC' },
      ],
    });
    const parsed = parseToolResult<{
      rows: Array<{ resolved: boolean; listing_id_sha?: string; error?: string }>;
    }>(r);
    expect(attempts).toBe(2);
    expect(parsed.rows[0].resolved).toBe(true);
    expect(parsed.rows[0].listing_id_sha).toBe('sha-retry');
  });

  // Issue #67: bulk vs single resolver parity audit.
  //
  // The bulk path historically grew its own copy of the address-match
  // helper that used `cand.includes(t)` substring containment, while the
  // single path used whole-token equality (the explicit fix for the
  // #55 prefix-collision class). Bulk amplifies the corruption surface,
  // so the two MUST run the same match policy.
  describe('#67 bulk/single parity', () => {
    it('CRITICAL: rejects a prefix-collision wrong-match (parity with single)', async () => {
      // Query "12 Oak St" must NOT match candidate "1234 Oak St" — the
      // single's `addressMatchesQuery` explicitly guards this class via
      // whole-token equality. Bulk must do the same.
      mockFetchHtml.mockResolvedValue(
        searchHtml([
          {
            listing: {
              listingIdSHA: 'sha-prefix-collision',
              pageLink: '/homedetails/1234-oak-st-dallas-tx/sha-prefix-collision_lid/',
              subtitles: ['1234 Oak St', 'Dallas, TX'],
            },
          },
        ])
      );
      const r = await harness.callTool('compass_resolve_addresses', {
        addresses: [{ address: '12 Oak St', city: 'Dallas', state: 'TX' }],
      });
      const parsed = parseToolResult<{
        rows: Array<{ resolved: boolean; url?: string }>;
      }>(r);
      expect(parsed.rows[0].resolved).toBe(false);
      expect(parsed.rows[0].url).toBeUndefined();
    });

    it('CRITICAL: rejects city-substring wrong-match (parity with single)', async () => {
      // Query city "Lee" must NOT match candidate city "Leesburg".
      mockFetchHtml.mockResolvedValue(
        searchHtml([
          {
            listing: {
              listingIdSHA: 'sha-leesburg',
              pageLink: '/homedetails/126-sleeping-bear-ln-leesburg-va/sha-leesburg_lid/',
              subtitles: ['126 Sleeping Bear Ln', 'Leesburg, VA'],
            },
          },
        ])
      );
      const r = await harness.callTool('compass_resolve_addresses', {
        addresses: [{ address: '126 Sleeping Bear Ln', city: 'Lee', state: 'VA' }],
      });
      const parsed = parseToolResult<{
        rows: Array<{ resolved: boolean; url?: string }>;
      }>(r);
      expect(parsed.rows[0].resolved).toBe(false);
      expect(parsed.rows[0].url).toBeUndefined();
    });

    it('partitions identically to N parallel single calls', async () => {
      // Pin the parity contract: `compass_resolve_addresses(set)` must
      // partition resolved/unresolved identically to calling
      // `compass_get_by_address` once per input. Mock the upstream
      // deterministically so the only variable is the in-process match
      // policy.
      const fixtures: Record<string, unknown[]> = {
        // Clean match.
        '126 Sleeping Bear Ln Lake Lure NC': [
          {
            listing: {
              listingIdSHA: 'sha-match-1',
              pageLink: '/homedetails/126-sleeping-bear-ln/sha-match-1_lid/',
              navigationPageLink: '/listing/126-sleeping-bear-ln/PID1_pid/',
              subtitles: ['126 Sleeping Bear Ln', 'Lake Lure, NC 28746'],
            },
          },
        ],
        // Silent-wrong-match (#45): candidate disagrees on city.
        '500 Different Way Lake Lure NC': [
          {
            listing: {
              listingIdSHA: 'sha-charlotte',
              pageLink: '/homedetails/1234-tryon-st-charlotte-nc/sha-charlotte_lid/',
              subtitles: ['1234 Tryon St', 'Charlotte, NC 28202'],
            },
          },
        ],
        // Prefix collision (#55/#67): "12 Oak St" vs "1234 Oak St".
        '12 Oak St Dallas TX': [
          {
            listing: {
              listingIdSHA: 'sha-prefix',
              pageLink: '/homedetails/1234-oak-st/sha-prefix_lid/',
              subtitles: ['1234 Oak St', 'Dallas, TX'],
            },
          },
        ],
      };
      const impl = async (path: string) => {
        const m = /q=([^&]+)/.exec(path);
        const q = m ? decodeURIComponent(m[1]) : '';
        return searchHtml(fixtures[q] ?? []);
      };

      // Drive the single via its own harness.
      const singleHarness = await createTestHarness((server) =>
        registerByAddressTools(server, mockClient)
      );
      try {
        const inputs = [
          { address: '126 Sleeping Bear Ln', city: 'Lake Lure', state: 'NC' },
          { address: '500 Different Way', city: 'Lake Lure', state: 'NC' },
          { address: '12 Oak St', city: 'Dallas', state: 'TX' },
        ];

        mockFetchHtml.mockImplementation(impl);
        const singleResults = await Promise.all(
          inputs.map((i) => singleHarness.callTool('compass_get_by_address', i))
        );
        const singleResolved = singleResults.map(
          (r) => parseToolResult<{ resolved: boolean }>(r).resolved
        );

        mockFetchHtml.mockImplementation(impl);
        const bulkResult = await harness.callTool('compass_resolve_addresses', {
          addresses: inputs,
        });
        const bulkRows = parseToolResult<{
          rows: Array<{ resolved: boolean }>;
        }>(bulkResult).rows;
        const bulkResolved = bulkRows.map((r) => r.resolved);

        // The partition must match exactly.
        expect(bulkResolved).toEqual(singleResolved);
        // And anchor the expected partition so a future regression in
        // BOTH paths still fails this test.
        expect(bulkResolved).toEqual([true, false, false]);
      } finally {
        await singleHarness.close();
      }
    });
  });

  // Issue #71: search-fallback rung. Parity contract from #68 means bulk
  // must walk the same rungs as single — both routes must surface
  // matched_via and both must fall through to the slug-based search
  // when ?q= comes up empty.
  describe('#71 search-fallback rung parity', () => {
    it('bulk rows surface matched_via from the shared resolver', async () => {
      // Row 1: matches on ?q= (one fetch).
      // Row 2: ?q= empty, slug returns a match (two fetches).
      mockFetchHtml.mockImplementation(async (path: string) => {
        if (path.startsWith('/homes-for-sale/?q=')) {
          const m = /q=([^&]+)/.exec(path);
          const q = m ? decodeURIComponent(m[1]) : '';
          if (q.includes('500 Main')) {
            return searchHtml([
              {
                listing: {
                  listingIdSHA: 'sha-ft',
                  pageLink: '/homedetails/500-main-st/sha-ft_lid/',
                  subtitles: ['500 Main St', 'Asheville, NC'],
                },
              },
            ]);
          }
          return searchHtml([]); // 126 Sleeping Bear Ln ?q= → empty.
        }
        // Slug rung for the Lake Lure address.
        if (path.includes('lake-lure-nc')) {
          return searchHtml([
            {
              listing: {
                listingIdSHA: 'sha-fb',
                pageLink: '/homedetails/126-sleeping-bear-ln/sha-fb_lid/',
                subtitles: ['126 Sleeping Bear Ln', 'Lake Lure, NC 28746'],
              },
            },
          ]);
        }
        return searchHtml([]);
      });

      const r = await harness.callTool('compass_resolve_addresses', {
        addresses: [
          { address: '500 Main St', city: 'Asheville', state: 'NC' },
          { address: '126 Sleeping Bear Ln', city: 'Lake Lure', state: 'NC' },
        ],
      });
      const parsed = parseToolResult<{
        rows: Array<{ resolved: boolean; matched_via?: string }>;
      }>(r);
      expect(parsed.rows[0].resolved).toBe(true);
      expect(parsed.rows[0].matched_via).toBe('freetext');
      expect(parsed.rows[1].resolved).toBe(true);
      expect(parsed.rows[1].matched_via).toBe('search_fallback');
    });

    it('CRITICAL parity: bulk partitions identically to single when fallback is load-bearing', async () => {
      // Three rows with varying rung behavior. The bulk + single
      // resolvers MUST partition resolved/unresolved AND matched_via
      // identically — this pins the #68 parity contract to the new rung.
      const impl = async (path: string) => {
        if (path.startsWith('/homes-for-sale/?q=')) {
          const m = /q=([^&]+)/.exec(path);
          const q = m ? decodeURIComponent(m[1]) : '';
          // Row A: clean ?q= hit.
          if (q.includes('500 Main')) {
            return searchHtml([
              {
                listing: {
                  listingIdSHA: 'sha-A',
                  pageLink: '/homedetails/500-main-st/sha-A_lid/',
                  subtitles: ['500 Main St', 'Asheville, NC'],
                },
              },
            ]);
          }
          // Row B + C: ?q= empty → fallback.
          return searchHtml([]);
        }
        // Slug rung. Row B's locality (lake-lure-nc) has a matching
        // listing; Row C's slug returns nothing (unresolved).
        if (path.includes('lake-lure-nc')) {
          return searchHtml([
            {
              listing: {
                listingIdSHA: 'sha-B',
                pageLink: '/homedetails/126-sleeping-bear-ln/sha-B_lid/',
                subtitles: ['126 Sleeping Bear Ln', 'Lake Lure, NC 28746'],
              },
            },
          ]);
        }
        return searchHtml([]);
      };

      const inputs = [
        { address: '500 Main St', city: 'Asheville', state: 'NC' },
        { address: '126 Sleeping Bear Ln', city: 'Lake Lure', state: 'NC' },
        { address: '999 Nowhere Rd', city: 'Atlantis', state: 'XX' },
      ];

      const singleHarness = await createTestHarness((server) =>
        registerByAddressTools(server, mockClient)
      );
      try {
        mockFetchHtml.mockImplementation(impl);
        const singleResults = await Promise.all(
          inputs.map((i) =>
            singleHarness.callTool('compass_get_by_address', i)
          )
        );
        const singleShape = singleResults.map((r) => {
          const p = parseToolResult<{
            resolved: boolean;
            matched_via?: string;
          }>(r);
          return { resolved: p.resolved, matched_via: p.matched_via };
        });

        mockFetchHtml.mockImplementation(impl);
        const bulkResult = await harness.callTool('compass_resolve_addresses', {
          addresses: inputs,
        });
        const bulkRows = parseToolResult<{
          rows: Array<{ resolved: boolean; matched_via?: string }>;
        }>(bulkResult).rows;
        const bulkShape = bulkRows.map((r) => ({
          resolved: r.resolved,
          matched_via: r.matched_via,
        }));

        expect(bulkShape).toEqual(singleShape);
        expect(bulkShape).toEqual([
          { resolved: true, matched_via: 'freetext' },
          { resolved: true, matched_via: 'search_fallback' },
          { resolved: false, matched_via: undefined },
        ]);
      } finally {
        await singleHarness.close();
      }
    });
  });

  // Issue #78/#79: structured typeahead rung parity. The bulk path must
  // resolve via the omnisuggest autocomplete endpoint as its primary
  // rung, identically to the single path, and surface
  // matched_via: "typeahead".
  describe('#78/#79 structured typeahead rung parity', () => {
    it('CRITICAL #78: resolves both Lake Lure false-negatives via the typeahead rung', async () => {
      mockFetchJson.mockImplementation(async (_path: string, init: any) => {
        const q: string = JSON.parse(JSON.stringify(init.body)).q;
        if (q.includes('158 Raven')) {
          return omnisuggest([
            {
              text: '158 Raven Blvd',
              subText: 'Lake Lure, NC',
              id: '2029026490125049409',
            },
          ]);
        }
        if (q.includes('155 Quail Cove')) {
          return omnisuggest([
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
          ]);
        }
        return { categories: [] };
      });

      const r = await harness.callTool('compass_resolve_addresses', {
        addresses: [
          { address: '158 Raven Blvd', city: 'Lake Lure', state: 'NC', zip: '28746' },
          {
            address: '155 Quail Cove Blvd Unit 1601',
            city: 'Lake Lure',
            state: 'NC',
            zip: '28746',
          },
        ],
      });
      const parsed = parseToolResult<{
        rows: Array<{
          resolved: boolean;
          matched_via?: string;
          listing_id_sha?: string;
          url?: string;
        }>;
      }>(r);
      expect(parsed.rows[0].resolved).toBe(true);
      expect(parsed.rows[0].matched_via).toBe('typeahead');
      expect(parsed.rows[0].listing_id_sha).toBe('2029026490125049409');
      expect(parsed.rows[0].url).toBe(
        'https://www.compass.com/homedetails/2029026490125049409_lid/'
      );
      expect(parsed.rows[1].resolved).toBe(true);
      expect(parsed.rows[1].matched_via).toBe('typeahead');
      expect(parsed.rows[1].listing_id_sha).toBe('2079951245069150641');
      // Never hits the SSR rungs when typeahead resolves.
      expect(mockFetchHtml).not.toHaveBeenCalled();
    });

    it('CRITICAL parity: bulk partitions identically to single across all three rungs', async () => {
      // Row A → typeahead hit; Row B → typeahead empty, SSR ?q= hit;
      // Row C → all rungs empty (unresolved). Bulk + single must agree.
      const jsonImpl = async (_path: string, init: any) => {
        const q: string = JSON.parse(JSON.stringify(init.body)).q;
        if (q.includes('158 Raven')) {
          return omnisuggest([
            {
              text: '158 Raven Blvd',
              subText: 'Lake Lure, NC',
              id: 'sha-ta',
            },
          ]);
        }
        return { categories: [] };
      };
      const htmlImpl = async (path: string) => {
        if (path.startsWith('/homes-for-sale/?q=')) {
          const m = /q=([^&]+)/.exec(path);
          const qq = m ? decodeURIComponent(m[1]) : '';
          if (qq.includes('500 Main')) {
            return searchHtml([
              {
                listing: {
                  listingIdSHA: 'sha-ft',
                  pageLink: '/homedetails/500-main-st/sha-ft_lid/',
                  subtitles: ['500 Main St', 'Asheville, NC'],
                },
              },
            ]);
          }
        }
        return searchHtml([]);
      };

      const inputs = [
        { address: '158 Raven Blvd', city: 'Lake Lure', state: 'NC' },
        { address: '500 Main St', city: 'Asheville', state: 'NC' },
        { address: '999 Nowhere Rd', city: 'Atlantis', state: 'XX' },
      ];

      const singleHarness = await createTestHarness((server) =>
        registerByAddressTools(server, mockClient)
      );
      try {
        mockFetchJson.mockImplementation(jsonImpl);
        mockFetchHtml.mockImplementation(htmlImpl);
        const singleResults = await Promise.all(
          inputs.map((i) => singleHarness.callTool('compass_get_by_address', i))
        );
        const singleShape = singleResults.map((r) => {
          const p = parseToolResult<{ resolved: boolean; matched_via?: string }>(r);
          return { resolved: p.resolved, matched_via: p.matched_via };
        });

        mockFetchJson.mockImplementation(jsonImpl);
        mockFetchHtml.mockImplementation(htmlImpl);
        const bulkResult = await harness.callTool('compass_resolve_addresses', {
          addresses: inputs,
        });
        const bulkShape = parseToolResult<{
          rows: Array<{ resolved: boolean; matched_via?: string }>;
        }>(bulkResult).rows.map((r) => ({
          resolved: r.resolved,
          matched_via: r.matched_via,
        }));

        expect(bulkShape).toEqual(singleShape);
        expect(bulkShape).toEqual([
          { resolved: true, matched_via: 'typeahead' },
          { resolved: true, matched_via: 'freetext' },
          { resolved: false, matched_via: undefined },
        ]);
      } finally {
        await singleHarness.close();
      }
    });
  });
});
