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
  bridgeHealth: ReturnType<typeof vi.fn>;
  role: 'host' | 'peer' | null;
};

function stubInner(role: 'host' | 'peer' | null = 'host'): Inner {
  return {
    listen: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    request: vi.fn(),
    bridgeHealth: vi.fn().mockReturnValue({
      role,
      port: 37149,
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

  it('status().role tracks whatever role the inner reports (null pre-listen)', () => {
    const t = new FetchproxyTransport({ version: '1.0.0' });
    const inner = stubInner(null);
    inner.bridgeHealth.mockReturnValue({
      role: null,
      port: 37149,
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
});
