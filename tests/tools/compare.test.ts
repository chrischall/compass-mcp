import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { CompassClient } from '../../src/client.js';
import { buildSummary, registerCompareTools } from '../../src/tools/compare.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as CompassClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

const htmlWith = (listing: unknown) => {
  const data = { props: { listingRelation: { listing } } };
  return `<html><script>window.__INITIAL_DATA__ = ${JSON.stringify(data)};</script></html>`;
};

describe('buildSummary', () => {
  it('aligns per-field values across rows + null-fills errors', () => {
    const rows = [
      {
        listing_id_sha: 'a',
        property: { url: 'u', address: '1 Main', price: 100, beds: 2 } as never,
      },
      { listing_id_sha: 'b', error: 'fetch failed' },
      {
        listing_id_sha: 'c',
        property: { url: 'u', address: '3 Main', price: 300, beds: 4 } as never,
      },
    ];
    const summary = buildSummary(rows);
    const price = summary.find((r) => r.field === 'price')!;
    expect(price.values).toEqual([100, null, 300]);
    const beds = summary.find((r) => r.field === 'beds')!;
    expect(beds.values).toEqual([2, null, 4]);
  });
});

describe('compass_compare_properties tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerCompareTools(server, mockClient)
    );
  });

  it('runs concurrent fetches per target and aligns the summary', async () => {
    let n = 0;
    mockFetchHtml.mockImplementation(async () => {
      n++;
      return htmlWith({
        listingIdSHA: `id-${n}`,
        pageLink: `/h/${n}/`,
        location: { prettyAddress: `${n} Main` },
        size: { bedrooms: n, totalBathrooms: n },
        price: { lastKnown: n * 100_000, formatted: `$${n * 100}K` },
      });
    });

    const r = await harness.callTool('compass_compare_properties', {
      targets: [
        { url: '/homedetails/foo/a_lid/' },
        { url: '/homedetails/foo/b_lid/' },
        { url: '/homedetails/foo/c_lid/' },
      ],
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      count: number;
      results: Array<{ property?: { price?: number } }>;
    }>(r);
    expect(parsed.count).toBe(3);
    expect(parsed.results.map((res) => res.property?.price)).toEqual([
      100_000, 200_000, 300_000,
    ]);
  });

  it('resolves sha-only targets internally and returns them alongside url targets', async () => {
    // Mixed batch: url-shaped target fetches normally; sha-only target
    // first hits /homes-for-sale/?q=<sha> to recover the slug, then
    // fetches the listing record. Both succeed without the caller
    // having to know the slug.
    const searchUc = {
      sharedReactAppProps: {
        initialResults: {
          lolResults: {
            data: [
              {
                listing: {
                  listingIdSHA: '2079240952806311449',
                  pageLink: '/homedetails/foo/2079240952806311449_lid/',
                },
              },
            ],
          },
        },
      },
    };
    const searchHtml = `<html><script>global.uc = ${JSON.stringify(searchUc)};</script></html>`;
    mockFetchHtml.mockImplementation(async (path: string) => {
      if (path.startsWith('/homes-for-sale/?q=')) return searchHtml;
      return htmlWith({
        listingIdSHA: path.includes('good') ? 'good' : '2079240952806311449',
        pageLink: path,
        price: {
          lastKnown: path.includes('good') ? 1_000_000 : 2_000_000,
        },
      });
    });

    const r = await harness.callTool('compass_compare_properties', {
      targets: [
        { url: '/homedetails/foo/good_lid/' },
        { listing_id_sha: '2079240952806311449' },
      ],
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      results: Array<{ error?: string; property?: { price?: number } }>;
    }>(r);
    expect(parsed.results[0].property?.price).toBe(1_000_000);
    expect(parsed.results[0].error).toBeUndefined();
    expect(parsed.results[1].property?.price).toBe(2_000_000);
    expect(parsed.results[1].error).toBeUndefined();
  });

  it('omits summary by default — opt-in via include_summary (#39)', async () => {
    let n = 0;
    mockFetchHtml.mockImplementation(async () => {
      n++;
      return htmlWith({
        listingIdSHA: `id-${n}`,
        pageLink: `/h/${n}/`,
        location: { prettyAddress: `${n} Main` },
        price: { lastKnown: n * 100_000 },
      });
    });
    const r = await harness.callTool('compass_compare_properties', {
      targets: [
        { url: '/homedetails/foo/a_lid/' },
        { url: '/homedetails/foo/b_lid/' },
      ],
    });
    const parsed = parseToolResult<{ summary?: unknown; results: unknown[] }>(r);
    // Default behaviour: no summary. The pivoted table is redundant
    // with rows[].property.* and was ~30% of response weight per the
    // cross-MCP report — opt-in only.
    expect(parsed.summary).toBeUndefined();
    expect(parsed.results).toHaveLength(2);
  });

  it('returns summary when include_summary=true (#39)', async () => {
    let n = 0;
    mockFetchHtml.mockImplementation(async () => {
      n++;
      return htmlWith({
        listingIdSHA: `id-${n}`,
        pageLink: `/h/${n}/`,
        location: { prettyAddress: `${n} Main` },
        price: { lastKnown: n * 100_000 },
      });
    });
    const r = await harness.callTool('compass_compare_properties', {
      targets: [
        { url: '/homedetails/foo/a_lid/' },
        { url: '/homedetails/foo/b_lid/' },
      ],
      include_summary: true,
    });
    const parsed = parseToolResult<{
      summary?: Array<{ field: string; values: unknown[] }>;
    }>(r);
    expect(parsed.summary).toBeDefined();
    const price = parsed.summary!.find((r) => r.field === 'price')!;
    expect(price.values).toEqual([100_000, 200_000]);
  });

  it('accepts up to 25 targets — cap raised from 8 in #53', async () => {
    mockFetchHtml.mockImplementation(async () =>
      htmlWith({
        listingIdSHA: 'x',
        pageLink: '/x/x_lid/',
        price: { lastKnown: 1 },
      })
    );
    const r = await harness.callTool('compass_compare_properties', {
      targets: Array.from({ length: 25 }, (_, i) => ({
        url: `/homedetails/foo/x${i}_lid/`,
      })),
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{ count: number; results: unknown[] }>(r);
    expect(parsed.count).toBe(25);
  });

  it('rejects more than 25 targets', async () => {
    const r = await harness.callTool('compass_compare_properties', {
      targets: Array.from({ length: 26 }, (_, i) => ({
        url: `/homedetails/foo/x${i}_lid/`,
      })),
    });
    expect(r.isError).toBeTruthy();
  });


  it('captures per-target errors without failing the whole call', async () => {
    let n = 0;
    mockFetchHtml.mockImplementation(async () => {
      n++;
      if (n === 2) throw new Error('boom');
      return htmlWith({
        listingIdSHA: `id-${n}`,
        pageLink: `/h/${n}/`,
        location: { prettyAddress: `${n} Main` },
        price: { lastKnown: 500_000, formatted: '$500K' },
      });
    });

    const r = await harness.callTool('compass_compare_properties', {
      targets: [
        { url: '/homedetails/foo/a_lid/' },
        { url: '/homedetails/foo/b_lid/' },
        { url: '/homedetails/foo/c_lid/' },
      ],
    });
    const parsed = parseToolResult<{
      results: Array<{ error?: string; property?: { price?: number } }>;
    }>(r);
    expect(parsed.results[0].property?.price).toBe(500_000);
    expect(parsed.results[1].error).toMatch(/boom/);
    expect(parsed.results[2].property?.price).toBe(500_000);
  });
});
