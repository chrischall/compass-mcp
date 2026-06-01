// Adapter-level tests for FetchproxyTransport.
//
// As of @fetchproxy/server 0.8.0 the server owns lazy-revive, the
// per-request timeout, and the freshness counters — so this file is
// reduced to the compass-specific surface: relative path → subdomain
// resolution, absolute pass-through, status() mirroring bridgeHealth(),
// typed-error pass-through, and start/close delegation.
import { describe, it, expect, vi } from 'vitest';
import {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
  FetchproxyTransport,
} from '../src/transport-fetchproxy.js';

type Inner = {
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  requestJson: ReturnType<typeof vi.fn>;
  bridgeHealth: ReturnType<typeof vi.fn>;
  role: 'host' | 'peer' | null;
};

function stubInner(role: 'host' | 'peer' | null = 'host'): Inner {
  return {
    listen: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    request: vi.fn(),
    requestJson: vi.fn(),
    bridgeHealth: vi.fn().mockReturnValue({
      role,
      port: 37149,
      serverVersion: '0.0.0',
      fetchTimeoutMs: 30_000,
      bridgeReviveDelayMs: 2_000,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      consecutiveFailures: 0,
      lastExtensionMessageAt: null,
    }),
    role,
  };
}

function installInner(t: FetchproxyTransport, inner: Inner): void {
  // @ts-expect-error reach into the private field for unit testing
  t.inner = inner;
}

describe('FetchproxyTransport', () => {
  it('relative paths resolve against www.compass.com via subdomain: www', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.request.mockResolvedValue({
      status: 200,
      body: 'x',
      url: 'https://www.compass.com/home/40732555',
    });
    installInner(t, inner);

    await t.fetch({ path: '/home/40732555', method: 'GET' });
    const [method, path, opts] = inner.request.mock.calls[0];
    expect(method).toBe('GET');
    expect(path).toBe('/home/40732555');
    expect(opts.subdomain).toBe('www');
  });

  it('absolute URLs pass through; subdomain is harmless because the server derives tabUrl from the URL host', async () => {
    // 0.8.0+: server's request() ignores `subdomain` for absolute
    // paths and derives tabUrl from the URL host. So always passing
    // `subdomain: 'www'` is safe even for photos.compass.com URLs —
    // tabUrl will be `https://photos.compass.com/`, not www's.
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.request.mockResolvedValue({
      status: 200,
      body: '',
      url: 'https://photos.compass.com/x',
    });
    installInner(t, inner);

    await t.fetch({ path: 'https://photos.compass.com/x', method: 'GET' });
    const [, path] = inner.request.mock.calls[0];
    expect(path).toBe('https://photos.compass.com/x');
  });

  it('returns the {status, body, url} triple from inner.request()', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.request.mockResolvedValue({
      status: 200,
      body: 'hello',
      url: 'https://www.compass.com/x',
    });
    installInner(t, inner);

    const result = await t.fetch({ path: '/x', method: 'GET' });
    expect(result).toEqual({
      status: 200,
      body: 'hello',
      url: 'https://www.compass.com/x',
    });
  });

  it('forwards headers and body through to inner.request()', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.request.mockResolvedValue({
      status: 200,
      body: '{}',
      url: 'https://www.compass.com/api',
    });
    installInner(t, inner);

    await t.fetch({
      path: '/api',
      method: 'POST',
      headers: { 'X-Test': '1' },
      body: '{"k":1}',
    });
    const [, , opts] = inner.request.mock.calls[0];
    expect(opts.headers).toEqual({ 'X-Test': '1' });
    expect(opts.body).toBe('{"k":1}');
  });

  it('requestJson delegates to inner.requestJson with subdomain: www and returns {data, result}', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.requestJson.mockResolvedValue({
      data: { n: 42 },
      result: {
        ok: true,
        status: 200,
        body: '{"n":42}',
        url: 'https://www.compass.com/api',
      },
    });
    installInner(t, inner);

    const out = await t.requestJson<{ n: number }>('/api', {
      method: 'POST',
      headers: { 'X-Test': '1' },
      body: { n: 42 },
    });
    const [method, path, opts] = inner.requestJson.mock.calls[0];
    expect(method).toBe('POST');
    expect(path).toBe('/api');
    expect(opts.subdomain).toBe('www');
    expect(opts.headers).toEqual({ 'X-Test': '1' });
    expect(opts.body).toEqual({ n: 42 });
    expect(out).toEqual({
      data: { n: 42 },
      result: {
        status: 200,
        body: '{"n":42}',
        url: 'https://www.compass.com/api',
      },
    });
  });

  it('requestJson defaults method to POST and passes data: null through (204)', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.requestJson.mockResolvedValue({
      data: null,
      result: {
        ok: true,
        status: 204,
        body: '',
        url: 'https://www.compass.com/api',
      },
    });
    installInner(t, inner);

    const out = await t.requestJson('/api', { body: {} });
    const [method] = inner.requestJson.mock.calls[0];
    expect(method).toBe('POST');
    expect(out.data).toBeNull();
    expect(out.result.status).toBe(204);
  });

  it('propagates FetchproxyBridgeDownError thrown by inner.request()', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.request.mockRejectedValue(
      new FetchproxyBridgeDownError({
        originalError: 'Receiving end does not exist.',
        retryAttempted: true,
        op: 'fetch',
        url: 'https://www.compass.com/x',
      })
    );
    installInner(t, inner);

    await expect(t.fetch({ path: '/x', method: 'GET' })).rejects.toBeInstanceOf(
      FetchproxyBridgeDownError
    );
  });

  it('propagates FetchproxyTimeoutError thrown by inner.request()', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.request.mockRejectedValue(
      new FetchproxyTimeoutError({
        url: 'https://www.compass.com/slow',
        timeoutMs: 30000,
      })
    );
    installInner(t, inner);

    await expect(t.fetch({ path: '/slow', method: 'GET' })).rejects.toBeInstanceOf(
      FetchproxyTimeoutError
    );
  });

  it('status() mirrors inner.bridgeHealth() + adapter-owned fields', () => {
    const t = new FetchproxyTransport({
      version: '1.2.3',
      port: 37200,
      fetchTimeoutMs: 5000,
    });
    const inner = stubInner('host');
    inner.bridgeHealth.mockReturnValue({
      role: 'host',
      port: 37200,
      serverVersion: '1.2.3',
      fetchTimeoutMs: 5000,
      bridgeReviveDelayMs: 2_000,
      lastSuccessAt: 111,
      lastFailureAt: 222,
      lastFailureReason: 'boom',
      consecutiveFailures: 3,
      lastExtensionMessageAt: 333,
    });
    installInner(t, inner);

    expect(t.status()).toEqual({
      role: 'host',
      port: 37200,
      serverVersion: '1.2.3',
      fetchTimeoutMs: 5000,
      lastSuccessAt: 111,
      lastFailureAt: 222,
      lastFailureReason: 'boom',
      consecutiveFailures: 3,
      lastExtensionMessageAt: 333,
    });
  });

  it('status().fetchTimeoutMs is sourced from bridgeHealth() — not the constructor option (fetchproxy#82)', () => {
    // Regression guard: the adapter used to mirror opts.fetchTimeoutMs
    // into a private field and surface that through status(). That
    // drifted from the server's actual resolved value any time the
    // server changed its default or applied caller-side validation.
    // Now status().fetchTimeoutMs comes straight off bridgeHealth().
    const t = new FetchproxyTransport({
      version: '1.0.0',
      fetchTimeoutMs: 5000, // constructor option — ignored by status()
    });
    const inner = stubInner('host');
    inner.bridgeHealth.mockReturnValue({
      role: 'host',
      port: 37149,
      serverVersion: '1.0.0',
      fetchTimeoutMs: 12_345, // server-resolved value — wins
      bridgeReviveDelayMs: 2_000,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      consecutiveFailures: 0,
      lastExtensionMessageAt: null,
    });
    installInner(t, inner);

    expect(t.status().fetchTimeoutMs).toBe(12_345);
  });

  it('status().role tracks whatever role the inner reports (null pre-listen)', () => {
    const t = new FetchproxyTransport({ version: '1.0.0' });
    const inner = stubInner(null);
    inner.bridgeHealth.mockReturnValue({
      role: null,
      port: 37149,
      serverVersion: '1.0.0',
      fetchTimeoutMs: 30_000,
      bridgeReviveDelayMs: 2_000,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      consecutiveFailures: 0,
      lastExtensionMessageAt: null,
    });
    installInner(t, inner);
    expect(t.status().role).toBeNull();
  });

  it('start/close delegate to the inner FetchproxyServer', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    installInner(t, inner);

    await t.start();
    expect(inner.listen).toHaveBeenCalledTimes(1);

    await t.close();
    expect(inner.close).toHaveBeenCalledTimes(1);
  });

  it('does NOT pass keepAliveIntervalMs explicitly — relies on the 0.10.0 default of 25_000 (fetchproxy#71)', async () => {
    // 0.10.0 promoted keepAliveIntervalMs to a 25_000 default (the value
    // compass had been hardcoding), so the adapter no longer forwards it.
    // Use vi.doMock to swap in a capturing FetchproxyServer subclass,
    // then dynamically re-import FetchproxyTransport so its module-scope
    // binding resolves to the patched class.
    const seen: Array<Record<string, unknown>> = [];
    vi.resetModules();
    // src/transport-fetchproxy.ts imports FetchproxyServer via the
    // @chrischall/mcp-utils/fetchproxy re-export (single import site), so
    // mock THAT subpath — not the underlying '@fetchproxy/server' — or the
    // module-scope binding resolves to the real class and the capture misses.
    vi.doMock('@chrischall/mcp-utils/fetchproxy', async () => {
      const actual = await vi.importActual<
        typeof import('@chrischall/mcp-utils/fetchproxy')
      >('@chrischall/mcp-utils/fetchproxy');
      class Capturing extends actual.FetchproxyServer {
        constructor(opts: ConstructorParameters<typeof actual.FetchproxyServer>[0]) {
          seen.push(opts as unknown as Record<string, unknown>);
          super(opts);
        }
      }
      return { ...actual, FetchproxyServer: Capturing };
    });
    const { FetchproxyTransport: PatchedTransport } = await import(
      '../src/transport-fetchproxy.js'
    );

    new PatchedTransport({ version: '1.2.3' });

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty('keepAliveIntervalMs');

    vi.doUnmock('@chrischall/mcp-utils/fetchproxy');
    vi.resetModules();
  });
});
