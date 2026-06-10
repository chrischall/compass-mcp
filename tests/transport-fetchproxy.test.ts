// Adapter-level tests for FetchproxyTransport.
//
// As of @chrischall/mcp-utils 0.9, FetchproxyServer construction + the
// start/close lifecycle + the fetch / requestJson / runProbe verb passthroughs
// are factored into `createFetchproxyTransport`. compass's FetchproxyTransport
// is now a thin class that delegates to that inner adapter, keeping only the
// compass-specific pins (port 37149, serverName, compass.com domain,
// `defaultSubdomain: 'www'`) and the requestJson method-mapping (compass takes
// the method inside `init`; the adapter takes it positionally).
//
// These tests stub the inner adapter and assert the delegation contract:
// constructor wiring, verb forwarding (incl. the method-position remap),
// status() mirroring, runProbe forwarding, and start/close delegation.
import { describe, it, expect, vi } from 'vitest';
import {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
  FetchproxyTransport,
} from '../src/transport-fetchproxy.js';

type Inner = {
  start: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  requestJson: ReturnType<typeof vi.fn>;
  runProbe: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
};

function stubInner(role: 'host' | 'peer' | null = 'host'): Inner {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn(),
    requestJson: vi.fn(),
    runProbe: vi.fn(),
    status: vi.fn().mockReturnValue({
      role,
      port: 37149,
      serverVersion: '0.0.0',
      fetchTimeoutMs: 30_000,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      consecutiveFailures: 0,
      lastExtensionMessageAt: null,
    }),
  };
}

function installInner(t: FetchproxyTransport, inner: Inner): void {
  // @ts-expect-error reach into the private field for unit testing
  t.inner = inner;
}

describe('FetchproxyTransport', () => {
  it('forwards fetch() to the inner adapter (which applies defaultSubdomain: www) and returns its triple', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({
      status: 200,
      body: 'hello',
      url: 'https://www.compass.com/x',
    });
    installInner(t, inner);

    const result = await t.fetch({ path: '/x', method: 'GET' });
    expect(inner.fetch).toHaveBeenCalledWith({ path: '/x', method: 'GET' });
    expect(result).toEqual({
      status: 200,
      body: 'hello',
      url: 'https://www.compass.com/x',
    });
  });

  it('forwards headers and body through fetch() to the inner adapter', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({
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
    expect(inner.fetch).toHaveBeenCalledWith({
      path: '/api',
      method: 'POST',
      headers: { 'X-Test': '1' },
      body: '{"k":1}',
    });
  });

  it('requestJson remaps the method (compass: in init → adapter: positional) and returns {data, result}', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.requestJson.mockResolvedValue({
      data: { n: 42 },
      result: { status: 200, body: '{"n":42}', url: 'https://www.compass.com/api' },
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
    expect(opts.headers).toEqual({ 'X-Test': '1' });
    expect(opts.body).toEqual({ n: 42 });
    expect(out).toEqual({
      data: { n: 42 },
      result: { status: 200, body: '{"n":42}', url: 'https://www.compass.com/api' },
    });
  });

  it('requestJson defaults method to POST and passes data: null through (204)', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.requestJson.mockResolvedValue({
      data: null,
      result: { status: 204, body: '', url: 'https://www.compass.com/api' },
    });
    installInner(t, inner);

    const out = await t.requestJson('/api', { body: {} });
    const [method] = inner.requestJson.mock.calls[0];
    expect(method).toBe('POST');
    expect(out.data).toBeNull();
    expect(out.result.status).toBe(204);
  });

  it('propagates FetchproxyBridgeDownError thrown by the inner adapter fetch()', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockRejectedValue(
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

  it('propagates FetchproxyTimeoutError thrown by the inner adapter fetch()', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockRejectedValue(
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

  it('runProbe delegates to the inner adapter and returns its BridgeProbeResult', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    const probeResult = {
      ok: true,
      elapsed_ms: 12,
      bridge: {
        role: 'host',
        port: 37149,
        server_version: '0.0.0',
        fetch_timeout_ms: 30_000,
        last_success_at: null,
        last_failure_at: null,
        last_failure_reason: null,
        consecutive_failures: 0,
      },
    };
    inner.runProbe.mockResolvedValue(probeResult);
    installInner(t, inner);

    const fetchFn = vi.fn().mockResolvedValue('User-agent: *');
    const out = await t.runProbe(fetchFn, '/robots.txt');
    expect(inner.runProbe).toHaveBeenCalledWith(fetchFn, '/robots.txt');
    expect(out).toEqual(probeResult);
  });

  it('status() mirrors the inner adapter status() (bridgeHealth) verbatim', () => {
    const t = new FetchproxyTransport({ version: '1.2.3' });
    const inner = stubInner('host');
    const health = {
      role: 'host',
      port: 37200,
      serverVersion: '1.2.3',
      fetchTimeoutMs: 5000,
      lastSuccessAt: 111,
      lastFailureAt: 222,
      lastFailureReason: 'boom',
      consecutiveFailures: 3,
      lastExtensionMessageAt: 333,
    };
    inner.status.mockReturnValue(health);
    installInner(t, inner);

    expect(t.status()).toEqual(health);
  });

  it('status().role tracks whatever role the inner reports (null pre-listen)', () => {
    const t = new FetchproxyTransport({ version: '1.0.0' });
    const inner = stubInner(null);
    inner.status.mockReturnValue({
      role: null,
      port: 37149,
      serverVersion: '1.0.0',
      fetchTimeoutMs: 30_000,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      consecutiveFailures: 0,
      lastExtensionMessageAt: null,
    });
    installInner(t, inner);
    expect(t.status().role).toBeNull();
  });

  it('start/close delegate to the inner adapter', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    installInner(t, inner);

    await t.start();
    expect(inner.start).toHaveBeenCalledTimes(1);

    await t.close();
    expect(inner.close).toHaveBeenCalledTimes(1);
  });

  it('constructs the inner adapter with port 37149, compass.com domain, and defaultSubdomain: www', async () => {
    // The adapter owns FetchproxyServer construction; assert compass passes the
    // right pins by capturing createFetchproxyTransport's options.
    const seen: Array<Record<string, unknown>> = [];
    vi.resetModules();
    vi.doMock('@chrischall/mcp-utils/fetchproxy', async () => {
      const actual = await vi.importActual<
        typeof import('@chrischall/mcp-utils/fetchproxy')
      >('@chrischall/mcp-utils/fetchproxy');
      return {
        ...actual,
        createFetchproxyTransport: (opts: Record<string, unknown>) => {
          seen.push(opts);
          return {
            start: vi.fn(),
            close: vi.fn(),
            fetch: vi.fn(),
            requestJson: vi.fn(),
            runProbe: vi.fn(),
            status: vi.fn(),
          };
        },
      };
    });
    const { FetchproxyTransport: PatchedTransport } = await import(
      '../src/transport-fetchproxy.js'
    );

    new PatchedTransport({ version: '1.2.3' });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      port: 37149,
      serverName: 'compass-mcp',
      version: '1.2.3',
      domains: ['compass.com'],
      defaultSubdomain: 'www',
    });
    // 0.10.0 default of 25_000 — not forwarded explicitly (fetchproxy#71).
    expect(seen[0]).not.toHaveProperty('keepAliveIntervalMs');

    vi.doUnmock('@chrischall/mcp-utils/fetchproxy');
    vi.resetModules();
  });
});
