import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import {
  FetchproxyTimeoutError,
  FetchproxyBridgeDownError,
  FetchproxyProtocolError,
} from '@fetchproxy/server';
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

  it('marks a per-row bridge timeout (after retry) as a retryable transport fault, not a miss', async () => {
    // #73: swap ad-hoc `e.message` to `classifyRowError`. A bridge
    // timeout that survives the one-shot `retryOnceOnTimeout` is NOT a
    // "no listing found" — it must surface a distinct, retryable
    // `status` so a caller never reads it as a genuine miss.
    let n = 0;
    mockFetchHtml.mockImplementation(async () => {
      n++;
      // Target 2 times out on BOTH the initial call and the one-shot
      // retry, so `retryOnceOnTimeout` gives up and the row catch runs.
      if (n === 2 || n === 3) {
        throw new FetchproxyTimeoutError({
          url: '/h/b_lid/',
          timeoutMs: 30_000,
        });
      }
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
      ],
    });
    const parsed = parseToolResult<{
      rows: Array<{
        property?: { price?: number };
        error?: string;
        status?: string;
        retryable?: boolean;
      }>;
    }>(r);
    expect(parsed.rows[0].property?.price).toBe(500_000);
    expect(parsed.rows[1].status).toBe('timeout');
    expect(parsed.rows[1].retryable).toBe(true);
    expect(parsed.rows[1].error).toMatch(/timeout after retry/);
    expect(parsed.rows[1].property).toBeUndefined();
  });

  it('marks a per-row bridge-down as a retryable transport fault', async () => {
    mockFetchHtml.mockImplementation(async () => {
      throw new FetchproxyBridgeDownError({
        originalError: 'service worker offline',
        op: 'fetch',
        url: '/h/a_lid/',
      });
    });
    const r = await harness.callTool('compass_bulk_get', {
      targets: [{ url: '/homedetails/foo/a_lid/' }],
    });
    const parsed = parseToolResult<{
      rows: Array<{
        error?: string;
        status?: string;
        retryable?: boolean;
      }>;
    }>(r);
    expect(parsed.rows[0].status).toBe('bridge_down');
    expect(parsed.rows[0].retryable).toBe(true);
    expect(parsed.rows[0].error).toMatch(/bridge unreachable/);
  });

  it('keeps a genuine miss (no transport fault) as a plain error, with no status/retryable', async () => {
    // A protocol error and a plain Error are both "the lookup completed
    // and there's no listing here / parse failure" — they MUST stay
    // un-flagged so a caller treats them as real misses, not retries.
    let n = 0;
    mockFetchHtml.mockImplementation(async () => {
      n++;
      if (n === 1) throw new FetchproxyProtocolError('no signed-in tab');
      throw new Error('__INITIAL_DATA__.props.listingRelation.listing missing');
    });
    const r = await harness.callTool('compass_bulk_get', {
      targets: [
        { url: '/homedetails/foo/a_lid/' },
        { url: '/homedetails/foo/b_lid/' },
      ],
    });
    const parsed = parseToolResult<{
      rows: Array<{
        error?: string;
        status?: string;
        retryable?: boolean;
      }>;
    }>(r);
    // protocol → bare message, no status/retryable
    expect(parsed.rows[0].error).toBe('no signed-in tab');
    expect(parsed.rows[0].status).toBeUndefined();
    expect(parsed.rows[0].retryable).toBeUndefined();
    // genuine miss (plain Error) → message preserved, no status/retryable
    expect(parsed.rows[1].error).toMatch(/listing missing/);
    expect(parsed.rows[1].status).toBeUndefined();
    expect(parsed.rows[1].retryable).toBeUndefined();
  });

  it('caps in-flight fetches at BRIDGE_CONCURRENCY (=6)', async () => {
    // Migration to @fetchproxy/server 0.9.x bulk helpers. Before this
    // change compass used unbounded Promise.all and could put 100+
    // requests on the bridge at once; the round-3 #78 comparison
    // pinned 6 as the safe cohort cap. Track the peak by counting
    // resolves manually instead of letting Promise resolve immediately.
    let inflight = 0;
    let peak = 0;
    mockFetchHtml.mockImplementation(async () => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inflight--;
      return homedetailsHtml({
        listingIdSHA: 'x',
        pageLink: '/x/x_lid/',
        price: { lastKnown: 1 },
      });
    });
    const targets = Array.from({ length: 20 }, (_, i) => ({
      url: `/h/${i}_lid/`,
    }));
    await harness.callTool('compass_bulk_get', { targets });
    expect(peak).toBeLessThanOrEqual(6);
    // Also: peak should actually reach the cap on a 20-target batch —
    // otherwise the helper isn't engaging at all.
    expect(peak).toBeGreaterThan(1);
  });
});
