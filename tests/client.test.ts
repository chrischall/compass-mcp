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
    // Mirror the fetchproxy 0.10.0 `requestJson` envelope over the same
    // handler: build the FetchInit (Accept + Content-Type defaults,
    // JSON.stringify the body), call the handler, then parse + 204→null.
    // This keeps the fetchJson tests exercising the real serialization
    // contract the client relies on.
    requestJson: vi
      .fn()
      .mockImplementation(
        async (
          path: string,
          init: {
            method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
            headers?: Record<string, string>;
            body?: unknown;
          } = {}
        ) => {
          const method = init.method ?? 'POST';
          const fetchInit: FetchInit = {
            path,
            method,
            headers: {
              Accept: 'application/json',
              ...(method !== 'GET' && init.body !== undefined
                ? { 'Content-Type': 'application/json' }
                : {}),
              ...(init.headers ?? {}),
            },
            body:
              method === 'GET' || init.body === undefined
                ? undefined
                : JSON.stringify(init.body),
          };
          const result = await handler(fetchInit);
          const data =
            result.status === 204 || result.body === ''
              ? null
              : JSON.parse(result.body);
          return { data, result };
        }
      ),
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

  it('redacts Bearer/JWT secrets from the non-2xx error body preview', async () => {
    const secret = 'leaked-session-token-1a2b3c4d';
    const client = new CompassClient({
      transport: stubTransport(async () => ({
        status: 403,
        body: `<html>Forbidden.\n  Authorization: Bearer ${secret}\n</html>`,
        url: 'https://www.compass.com/x',
      })),
    });
    const err: Error = await client.fetchHtml('/x').then(
      () => {
        throw new Error('expected rejection');
      },
      (e: Error) => e
    );
    expect(err.message).toContain('403');
    expect(err.message).not.toContain(secret);
    expect(err.message).toContain('Bearer [REDACTED]');
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
