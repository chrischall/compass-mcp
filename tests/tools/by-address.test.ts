import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { CompassClient } from '../../src/client.js';
import {
  buildAddressQuery,
  extractPidFromNavigationPageLink,
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

  it('returns { resolved: false, error: "no listing found" } when there is no match', async () => {
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
    expect(parsed.error).toBe('no listing found');
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
});
