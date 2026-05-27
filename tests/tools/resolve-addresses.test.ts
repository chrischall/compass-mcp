import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { CompassClient } from '../../src/client.js';
import { registerResolveAddressesTools } from '../../src/tools/resolve-addresses.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as CompassClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
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
});
