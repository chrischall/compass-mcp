import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { CompassClient } from '../../src/client.js';
import { formatHistoryEvent, registerHistoryTools } from '../../src/tools/history.js';
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
