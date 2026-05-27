import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { CompassClient } from '../../src/client.js';
import {
  formatHistoryEvent,
  normalizeEventType,
  buildEventsNormalized,
  registerHistoryTools,
} from '../../src/tools/history.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as CompassClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

describe('formatHistoryEvent', () => {
  it('formats date + price + source attribution', () => {
    expect(
      formatHistoryEvent({
        feedListingId: '197766428168893089',
        timestamp: Date.parse('2018-05-18T05:00:00Z'),
        price: 937500,
        status: 10,
        localizedStatus: 'Sold',
        source: {
          externalSourceId: 'P1306461',
          externalSourceName: 'long_island_mlsli',
          sourceDisplayName: 'MLSLI',
        },
      })
    ).toEqual({
      date: '2018-05-18',
      event: 'Sold',
      status: 10,
      price: 937500,
      source: 'MLSLI',
      source_id: 'P1306461',
      external_source: 'long_island_mlsli',
      feed_listing_id: '197766428168893089',
    });
  });

  it('leaves date and price undefined when missing', () => {
    const out = formatHistoryEvent({});
    expect(out.date).toBeUndefined();
    expect(out.price).toBeUndefined();
  });
});

describe('normalizeEventType', () => {
  // The shared cross-MCP enum is documented in issue #48.
  it.each([
    ['Listed', 'Listed'],
    ['Active', 'Listed'],
    ['Coming Soon', 'Listed'],
    ['Re-listed', 'Relisted'],
    ['Relisted', 'Relisted'],
    ['Price Change', 'PriceChange'],
    ['Price Decrease', 'PriceChange'],
    ['Price Increase', 'PriceChange'],
    ['Pending', 'Pending'],
    ['Contingent', 'Contingent'],
    ['Sold', 'Sold'],
    ['Closed', 'Sold'],
    ['Withdrawn', 'Withdrawn'],
    ['Delisted', 'Delisted'],
    ['Off Market', 'Delisted'],
    ['Something Weird', undefined],
  ])('maps "%s" -> %s', (input, expected) => {
    expect(normalizeEventType(input)).toBe(expected);
  });
});

describe('buildEventsNormalized', () => {
  it('sorts by date ascending and computes price_change_pct relative to the previous priced event', () => {
    const out = buildEventsNormalized(
      [
        {
          timestamp: Date.parse('2024-03-01'),
          price: 950000,
          localizedStatus: 'Price Change',
        },
        {
          timestamp: Date.parse('2024-01-01'),
          price: 1000000,
          localizedStatus: 'Listed',
        },
      ],
      [
        {
          timestamp: Date.parse('2024-06-01'),
          price: 930000,
          localizedStatus: 'Sold',
        },
      ]
    );
    expect(out.map((e) => e.type)).toEqual(['Listed', 'PriceChange', 'Sold']);
    // 950000 vs 1000000 → -5.0%
    expect(out[1].price_change_pct).toBeCloseTo(-5.0, 1);
    // 930000 vs 950000 → -2.1%
    expect(out[2].price_change_pct).toBeCloseTo(-2.1, 1);
    // First event has no prior price → no pct.
    expect(out[0].price_change_pct).toBeUndefined();
  });

  it('drops events whose status does not normalize to a known enum', () => {
    const out = buildEventsNormalized(
      [
        {
          timestamp: Date.parse('2024-01-01'),
          price: 1000000,
          localizedStatus: 'Listed',
        },
        {
          timestamp: Date.parse('2024-02-01'),
          localizedStatus: 'unknown weird status',
        },
      ],
      []
    );
    // Only the recognized event survives.
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('Listed');
  });
});

describe('compass_get_price_history tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerHistoryTools(server, mockClient)
    );
  });

  const htmlWith = (events: unknown[], history: unknown[]) => {
    const data = {
      props: {
        listingRelation: {
          listing: {
            listingIdSHA: 'abc',
            pageLink: '/homedetails/foo/abc_lid/',
            events,
            history,
          },
        },
      },
    };
    return `<html><script>window.__INITIAL_DATA__ = ${JSON.stringify(data)};</script></html>`;
  };

  it('returns both events and history with attribution', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWith(
        [
          {
            timestamp: Date.parse('2018-02-11'),
            price: 979500,
            localizedStatus: 'Listed',
            source: { sourceDisplayName: 'MLSLI' },
          },
        ],
        [
          {
            timestamp: Date.parse('2018-05-18'),
            price: 937500,
            localizedStatus: 'Sold',
            source: { sourceDisplayName: 'MLSLI' },
          },
          {
            timestamp: Date.parse('2010-01-15'),
            price: 600000,
            localizedStatus: 'Sold',
            source: { sourceDisplayName: 'MLSLI' },
          },
        ]
      )
    );
    const r = await harness.callTool('compass_get_price_history', {
      url: '/homedetails/foo/abc_lid/',
    });
    const parsed = parseToolResult<{
      events_count: number;
      history_count: number;
      events: Array<{ event: string; price: number }>;
      history: Array<{ event: string; price: number }>;
    }>(r);
    expect(parsed.events_count).toBe(1);
    expect(parsed.history_count).toBe(2);
    expect(parsed.events[0].event).toBe('Listed');
    expect(parsed.history[0].price).toBe(937500);
  });

  it('surfaces pid alongside listing_id_sha when navigationPageLink carries a _pid/ form', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      `<html><script>window.__INITIAL_DATA__ = ${JSON.stringify({
        props: {
          listingRelation: {
            listing: {
              listingIdSHA: 'abc',
              pageLink: '/homedetails/foo/abc_lid/',
              navigationPageLink: '/homedetails/foo/203T5X_pid/',
              events: [],
              history: [],
            },
          },
        },
      })};</script></html>`
    );
    const r = await harness.callTool('compass_get_price_history', {
      url: '/homedetails/foo/abc_lid/',
    });
    const parsed = parseToolResult<{ pid?: string; listing_id_sha: string }>(r);
    expect(parsed.pid).toBe('203T5X');
    expect(parsed.listing_id_sha).toBe('abc');
  });

  it('emits events_normalized using the shared cross-MCP type enum (#48)', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWith(
        [
          {
            timestamp: Date.parse('2018-02-11'),
            price: 979500,
            localizedStatus: 'Listed',
            source: { sourceDisplayName: 'MLSLI' },
          },
          {
            timestamp: Date.parse('2018-03-01'),
            price: 950000,
            localizedStatus: 'Price Change',
            source: { sourceDisplayName: 'MLSLI' },
          },
          {
            timestamp: Date.parse('2018-04-01'),
            price: 950000,
            localizedStatus: 'Pending',
            source: { sourceDisplayName: 'MLSLI' },
          },
        ],
        [
          {
            timestamp: Date.parse('2018-05-18'),
            price: 937500,
            localizedStatus: 'Sold',
            source: { sourceDisplayName: 'MLSLI' },
          },
        ]
      )
    );
    const r = await harness.callTool('compass_get_price_history', {
      url: '/homedetails/foo/abc_lid/',
    });
    const parsed = parseToolResult<{
      events_normalized: Array<{
        date: string;
        type: string;
        price?: number;
        price_change_pct?: number;
        source_mls?: string;
      }>;
    }>(r);
    // All four events appear, in chronological order, mapped to the
    // shared enum.
    expect(parsed.events_normalized).toHaveLength(4);
    expect(parsed.events_normalized.map((e) => e.type)).toEqual([
      'Listed',
      'PriceChange',
      'Pending',
      'Sold',
    ]);
    // The "Price Change" event carries its computed pct
    // (979500 → 950000 ≈ -3.0%).
    const pc = parsed.events_normalized[1];
    expect(pc.price_change_pct).toBeCloseTo(-3.0, 1);
    expect(pc.source_mls).toBe('MLSLI');
  });

  it('returns empty arrays when the listing has no history', async () => {
    mockFetchHtml.mockResolvedValueOnce(htmlWith([], []));
    const r = await harness.callTool('compass_get_price_history', {
      url: '/homedetails/foo/abc_lid/',
    });
    const parsed = parseToolResult<{
      events_count: number;
      history_count: number;
    }>(r);
    expect(parsed.events_count).toBe(0);
    expect(parsed.history_count).toBe(0);
  });
});
