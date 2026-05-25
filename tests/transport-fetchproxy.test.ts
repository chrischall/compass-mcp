// Adapter-level tests for FetchproxyTransport. We don't bring up a real
// WebSocket here — the protocol-level tests live in @fetchproxy/server.
// What we verify is the path → URL prepending and the discriminated-
// union mapping (ok:true → triple, ok:false → throw).
import { describe, it, expect, vi } from 'vitest';
import {
  FetchproxyTimeoutError,
  FetchproxyTransport,
} from '../src/transport-fetchproxy.js';

type Inner = {
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  role: 'host' | 'peer' | null;
};

function stubInner(role: 'host' | 'peer' | null = 'host'): Inner {
  return {
    listen: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn(),
    role,
  };
}

function installInner(t: FetchproxyTransport, inner: Inner): void {
  // @ts-expect-error reach into the private field for unit testing
  t.inner = inner;
}

describe('FetchproxyTransport', () => {
  it('prepends https://www.compass.com to relative paths', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: 'x',
      url: 'https://www.compass.com/x',
    });
    installInner(t, inner);

    await t.fetch({ path: '/home/40732555', method: 'GET' });
    expect(inner.fetch.mock.calls[0][0].url).toBe(
      'https://www.compass.com/home/40732555'
    );
    expect(inner.fetch.mock.calls[0][0].tabUrl).toBe('https://www.compass.com/');
  });

  it('passes through absolute URLs', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: '',
      url: 'https://photos.compass.com/x',
    });
    installInner(t, inner);

    await t.fetch({
      path: 'https://photos.compass.com/x',
      method: 'GET',
    });
    expect(inner.fetch.mock.calls[0][0].url).toBe('https://photos.compass.com/x');
  });

  it('returns the {status, body, url} triple on ok:true', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({
      ok: true,
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

  it('throws when fetchproxy returns ok:false', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({
      ok: false,
      error: 'extension offline',
    });
    installInner(t, inner);

    await expect(t.fetch({ path: '/x', method: 'GET' })).rejects.toThrow(
      /extension offline/
    );
  });

  it('throws FetchproxyTimeoutError with role + port + elapsed diagnostics', async () => {
    const t = new FetchproxyTransport({
      version: '0.0.0',
      fetchTimeoutMs: 25,
      port: 37200,
    });
    const inner = stubInner('peer');
    // Never resolves — simulates a frozen tab / dropped extension.
    inner.fetch.mockReturnValue(new Promise(() => {}));
    installInner(t, inner);

    try {
      await t.fetch({ path: '/slow', method: 'GET' });
      expect.fail('expected timeout');
    } catch (e) {
      expect(e).toBeInstanceOf(FetchproxyTimeoutError);
      const err = e as FetchproxyTimeoutError;
      expect(err.role).toBe('peer');
      expect(err.port).toBe(37200);
      expect(err.timeoutMs).toBe(25);
      expect(err.elapsedMs).toBeGreaterThanOrEqual(25);
      expect(err.url).toBe('https://www.compass.com/slow');
      // The hint distinguishes "bridge never came up" (role null) from
      // "bridge alive, request stalled" (role non-null).
      expect(err.hint).toMatch(/bridge is role=peer on port 37200/);
    }
  });

  it('hint changes when role is still null (bridge never bound on startup)', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0', fetchTimeoutMs: 25 });
    const inner = stubInner(null);
    inner.fetch.mockReturnValue(new Promise(() => {}));
    installInner(t, inner);

    try {
      await t.fetch({ path: '/x', method: 'GET' });
      expect.fail('expected timeout');
    } catch (e) {
      const err = e as FetchproxyTimeoutError;
      expect(err.role).toBeNull();
      expect(err.hint).toMatch(/bridge never bound role/);
    }
  });

  it('swallows a late rejection on inner so the post-timeout WS drop is not an unhandled rejection', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0', fetchTimeoutMs: 25 });
    const inner = stubInner();
    // inner.fetch resolves nothing for the race, but then rejects later —
    // simulates a WebSocket drop happening AFTER the deadline already fired.
    inner.fetch.mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('ws closed unexpectedly')), 75);
        })
    );
    installInner(t, inner);

    // The transport.fetch call should reject with the timeout error first.
    await expect(t.fetch({ path: '/x', method: 'GET' })).rejects.toBeInstanceOf(
      FetchproxyTimeoutError
    );
    // Now let the late rejection settle. The no-op handler we attached
    // up front should consume it; if not, vitest reports an unhandled
    // rejection and fails the run.
    await new Promise((r) => setTimeout(r, 100));
  });

  it('does not fire the timeout when the inner fetch resolves in time', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0', fetchTimeoutMs: 1000 });
    const inner = stubInner();
    inner.fetch.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                ok: true,
                status: 200,
                body: 'ok',
                url: 'https://www.compass.com/x',
              }),
            10
          )
        )
    );
    installInner(t, inner);

    const result = await t.fetch({ path: '/x', method: 'GET' });
    expect(result.status).toBe(200);
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

  it('status() returns role + port + version + timeout', () => {
    const t = new FetchproxyTransport({
      version: '1.2.3',
      port: 37200,
      fetchTimeoutMs: 5000,
    });
    const inner = stubInner('host');
    installInner(t, inner);
    expect(t.status()).toEqual({
      role: 'host',
      port: 37200,
      serverVersion: '1.2.3',
      fetchTimeoutMs: 5000,
    });
  });

  it('status().role reflects whatever role the inner server reports (null pre-listen)', () => {
    const t = new FetchproxyTransport({ version: '1.0.0' });
    const inner = stubInner(null);
    installInner(t, inner);
    expect(t.status().role).toBeNull();
  });
});
