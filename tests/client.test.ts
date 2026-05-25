// CompassClient unit tests — error mapping + sign-in detection. Compass
// has no stingray-style JSON envelope, so this client is intentionally
// simpler than the Redfin one.
import { describe, it, expect, vi } from 'vitest';
import {
  CompassClient,
  SessionNotAuthenticatedError,
} from '../src/client.js';
import type {
  FetchInit,
  FetchResult,
  CompassTransport,
} from '../src/transport.js';

function stubTransport(
  handler: (init: FetchInit) => Promise<FetchResult>
): CompassTransport {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn().mockImplementation(handler),
    status: vi.fn().mockReturnValue({
      role: 'host',
      port: 37149,
      serverVersion: '0.0.0',
      fetchTimeoutMs: 30_000,
    }),
  };
}

describe('CompassClient', () => {
  it('fetchHtml returns the body when transport replies 200', async () => {
    const client = new CompassClient({
      transport: stubTransport(async () => ({
        status: 200,
        body: '<html>page</html>',
        url: 'https://www.compass.com/x',
      })),
    });
    expect(await client.fetchHtml('/x')).toBe('<html>page</html>');
  });

  it('fetchHtml throws SessionNotAuthenticatedError on /login redirect', async () => {
    const client = new CompassClient({
      transport: stubTransport(async () => ({
        status: 200,
        body: '<html>login form</html>',
        url: 'https://www.compass.com/login',
      })),
    });
    await expect(client.fetchHtml('/mycompass/favorites')).rejects.toBeInstanceOf(
      SessionNotAuthenticatedError
    );
  });

  it('fetchHtml throws SessionNotAuthenticatedError on AWS WAF challenge', async () => {
    const client = new CompassClient({
      transport: stubTransport(async () => ({
        status: 200,
        body:
          '<html><head><script src="https://22af.edge.sdk.awswaf.com/x/y/challenge.js"></script></head></html>',
        url: 'https://www.compass.com/x',
      })),
    });
    await expect(client.fetchHtml('/x')).rejects.toBeInstanceOf(
      SessionNotAuthenticatedError
    );
  });

  it('fetchHtml does NOT false-positive on a normal page mentioning awswaf.com in a large body', async () => {
    const big = 'x'.repeat(100_000) + 'awswaf.com challenge.js';
    const client = new CompassClient({
      transport: stubTransport(async () => ({
        status: 200,
        body: big,
        url: 'https://www.compass.com/privacy',
      })),
    });
    await expect(client.fetchHtml('/privacy')).resolves.toBeDefined();
  });

  it('fetchHtml throws for non-2xx status', async () => {
    const client = new CompassClient({
      transport: stubTransport(async () => ({
        status: 500,
        body: 'oops',
        url: 'https://www.compass.com/x',
      })),
    });
    await expect(client.fetchHtml('/x')).rejects.toThrow(/500/);
  });

  it('fetchJson POSTs JSON and parses the reply', async () => {
    const client = new CompassClient({
      transport: stubTransport(async (init) => {
        expect(init.method).toBe('POST');
        const body = JSON.parse(String(init.body));
        return {
          status: 200,
          body: JSON.stringify({ echoed: body }),
          url: 'https://www.compass.com/x',
        };
      }),
    });
    const r = await client.fetchJson<{ echoed: { n: number } }>('/x', {
      method: 'POST',
      body: { n: 42 },
    });
    expect(r.echoed.n).toBe(42);
  });

  it('fetchJson returns null for 204', async () => {
    const client = new CompassClient({
      transport: stubTransport(async () => ({
        status: 204,
        body: '',
        url: 'https://www.compass.com/x',
      })),
    });
    expect(await client.fetchJson('/x', { method: 'POST', body: {} })).toBeNull();
  });
});
