import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { CompassClient } from '../../src/client.js';
import { registerBulkGetTools } from '../../src/tools/bulk-get.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as CompassClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

const homedetailsHtml = (listing: unknown) => {
  const data = { props: { listingRelation: { listing } } };
  return `<html><script>window.__INITIAL_DATA__ = ${JSON.stringify(data)};</script></html>`;
};

describe('compass_bulk_get tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerBulkGetTools(server, mockClient)
    );
  });

  it('fetches one row per target by url, returning structured records', async () => {
    let n = 0;
    mockFetchHtml.mockImplementation(async () => {
      n++;
      return homedetailsHtml({
        listingIdSHA: `id-${n}`,
        pageLink: `/h/${n}/`,
        price: { lastKnown: n * 100_000 },
        location: { prettyAddress: `${n} Main` },
      });
    });
    const r = await harness.callTool('compass_bulk_get', {
      targets: [
        { url: '/homedetails/foo/a_lid/' },
        { url: '/homedetails/foo/b_lid/' },
        { url: '/homedetails/foo/c_lid/' },
      ],
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      count: number;
      rows: Array<{ property?: { price?: number; address?: string }; error?: string }>;
    }>(r);
    expect(parsed.count).toBe(3);
    expect(parsed.rows.map((row) => row.property?.price)).toEqual([
      100_000, 200_000, 300_000,
    ]);
    // No `summary` block — bulk_get is structured-only.
    expect((parsed as unknown as { summary?: unknown }).summary).toBeUndefined();
  });

  it('captures per-target errors without failing the whole call', async () => {
    let n = 0;
    mockFetchHtml.mockImplementation(async () => {
      n++;
      if (n === 2) throw new Error('boom');
      return homedetailsHtml({
        listingIdSHA: `id-${n}`,
        pageLink: `/h/${n}/`,
        price: { lastKnown: 500_000 },
      });
    });
    const r = await harness.callTool('compass_bulk_get', {
      targets: [
        { url: '/homedetails/foo/a_lid/' },
        { url: '/homedetails/foo/b_lid/' },
        { url: '/homedetails/foo/c_lid/' },
      ],
    });
    const parsed = parseToolResult<{
      rows: Array<{ property?: { price?: number }; error?: string }>;
    }>(r);
    expect(parsed.rows[0].property?.price).toBe(500_000);
    expect(parsed.rows[1].error).toMatch(/boom/);
    expect(parsed.rows[2].property?.price).toBe(500_000);
  });

  it('omits raw description by default', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      homedetailsHtml({
        listingIdSHA: 'abc',
        pageLink: '/h/abc/',
        description: 'Lakefront cabin.',
      })
    );
    const r = await harness.callTool('compass_bulk_get', {
      targets: [{ url: '/homedetails/foo/abc_lid/' }],
    });
    const parsed = parseToolResult<{
      rows: Array<{ property?: { description?: string; extracted_features?: unknown } }>;
    }>(r);
    expect(parsed.rows[0].property?.description).toBeUndefined();
    expect(parsed.rows[0].property?.extracted_features).toBeDefined();
  });

  it('returns raw description when include_description=true', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      homedetailsHtml({
        listingIdSHA: 'abc',
        pageLink: '/h/abc/',
        description: 'Lakefront cabin.',
      })
    );
    const r = await harness.callTool('compass_bulk_get', {
      targets: [{ url: '/homedetails/foo/abc_lid/' }],
      include_description: true,
    });
    const parsed = parseToolResult<{
      rows: Array<{ property?: { description?: string } }>;
    }>(r);
    expect(parsed.rows[0].property?.description).toBe('Lakefront cabin.');
  });

  it('accepts up to 200 targets — high enough to subsume sequential compare batches', async () => {
    // Above the 8-target compare_properties cap; bulk_get's whole point.
    mockFetchHtml.mockImplementation(async () =>
      homedetailsHtml({
        listingIdSHA: 'x',
        pageLink: '/x/x_lid/',
        price: { lastKnown: 1 },
      })
    );
    const targets = Array.from({ length: 25 }, (_, i) => ({
      url: `/h/${i}_lid/`,
    }));
    const r = await harness.callTool('compass_bulk_get', { targets });
    const parsed = parseToolResult<{ count: number }>(r);
    expect(parsed.count).toBe(25);
  });
});
