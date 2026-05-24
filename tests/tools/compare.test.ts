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
        { listing_id_sha: 'a' },
        { listing_id_sha: 'b' },
        { listing_id_sha: 'c' },
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
        { listing_id_sha: 'a' },
        { listing_id_sha: 'b' },
        { listing_id_sha: 'c' },
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
