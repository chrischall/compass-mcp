// Adapter-level tests for FetchproxyTransport. We don't bring up a real
// WebSocket here — the protocol-level tests live in @fetchproxy/server.
// What we verify is the path → URL prepending and the discriminated-
// union mapping (ok:true → triple, ok:false → throw).
import { describe, it, expect, vi } from 'vitest';
import {
  FetchproxyBridgeDownError,
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

  // The "Could not establish connection. Receiving end does not exist."
  // string comes from Chrome's runtime.sendMessage when the extension's
  // service worker has been evicted (the default eviction window is ~30s
  // idle). Map that one specific failure mode to a typed error with the
  // same diagnostic shape we already give for timeouts — so callers can
  // tell "SW dead" apart from "extension offline" apart from "Compass
  // returned 410" without grep'ing strings.
  it('throws FetchproxyBridgeDownError on SW-eviction error pattern', async () => {
    const t = new FetchproxyTransport({
      version: '0.0.0',
      port: 37200,
    });
    const inner = stubInner('peer');
    inner.fetch.mockResolvedValue({
      ok: false,
      error:
        'tab fetch failed: Error: Could not establish connection. Receiving end does not exist.',
    });
    installInner(t, inner);

    try {
      await t.fetch({ path: '/x', method: 'GET' });
      expect.fail('expected bridge-down error');
    } catch (e) {
      expect(e).toBeInstanceOf(FetchproxyBridgeDownError);
      const err = e as FetchproxyBridgeDownError;
      expect(err.role).toBe('peer');
      expect(err.port).toBe(37200);
      expect(err.url).toBe('https://www.compass.com/x');
      expect(err.originalError).toMatch(/Could not establish connection/);
      // Hint must mention service worker so the next debugger knows
      // where to look — the upstream extension, not this repo.
      expect(err.hint).toMatch(/service worker/i);
    }
  });

  it('matches the "Receiving end does not exist" half of the SW-eviction string', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({
      ok: false,
      error: 'Receiving end does not exist.',
    });
    installInner(t, inner);
    await expect(t.fetch({ path: '/x', method: 'GET' })).rejects.toBeInstanceOf(
      FetchproxyBridgeDownError
    );
  });

  it('still throws a generic Error (not FetchproxyBridgeDownError) for unrelated ok:false reasons', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({
      ok: false,
      error: 'no compass.com tab open',
    });
    installInner(t, inner);
    // Must reject — but NOT as a bridge-down error.
    try {
      await t.fetch({ path: '/x', method: 'GET' });
      expect.fail('expected reject');
    } catch (e) {
      expect(e).not.toBeInstanceOf(FetchproxyBridgeDownError);
      expect((e as Error).message).toMatch(/no compass\.com tab open/);
    }
  });

  // Freshness counters give the operator visibility into "is this
  // bridge healthy or limping along." A long-idle bridge with no recent
  // success is hard to distinguish from a brand-new one — these counters
  // give compass_healthcheck something concrete to surface.
  it('updates lastSuccessAt + resets consecutiveFailures on success', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: 'ok',
      url: 'https://www.compass.com/x',
    });
    installInner(t, inner);

    const before = t.status();
    expect(before.lastSuccessAt).toBeNull();
    expect(before.consecutiveFailures).toBe(0);

    const t0 = Date.now();
    await t.fetch({ path: '/x', method: 'GET' });
    const after = t.status();
    expect(after.lastSuccessAt).not.toBeNull();
    expect(after.lastSuccessAt!).toBeGreaterThanOrEqual(t0);
    expect(after.consecutiveFailures).toBe(0);
  });

  it('updates lastFailureAt + increments consecutiveFailures on failure', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    inner.fetch.mockResolvedValue({
      ok: false,
      error: 'something broke',
    });
    installInner(t, inner);

    await expect(t.fetch({ path: '/a', method: 'GET' })).rejects.toThrow();
    await expect(t.fetch({ path: '/b', method: 'GET' })).rejects.toThrow();
    const s = t.status();
    expect(s.lastFailureAt).not.toBeNull();
    expect(s.consecutiveFailures).toBe(2);
    expect(s.lastFailureReason).toMatch(/something broke/);
  });

  it('resets consecutiveFailures back to 0 after a successful fetch', async () => {
    const t = new FetchproxyTransport({ version: '0.0.0' });
    const inner = stubInner();
    // Two failures then a success.
    inner.fetch
      .mockResolvedValueOnce({ ok: false, error: 'transient' })
      .mockResolvedValueOnce({ ok: false, error: 'transient' })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: 'ok',
        url: 'https://www.compass.com/x',
      });
    installInner(t, inner);

    await expect(t.fetch({ path: '/x', method: 'GET' })).rejects.toThrow();
    await expect(t.fetch({ path: '/x', method: 'GET' })).rejects.toThrow();
    expect(t.status().consecutiveFailures).toBe(2);
    await t.fetch({ path: '/x', method: 'GET' });
    expect(t.status().consecutiveFailures).toBe(0);
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
      // Timer precision varies in CI — assert the field is present and
      // roughly within the timeout's order of magnitude, not the exact
      // setTimeout deadline. Real timers don't guarantee >= the configured
      // delay; 24ms is enough to fail >= 25 on a fast runner.
      expect(err.elapsedMs).toBeGreaterThan(0);
      expect(err.elapsedMs).toBeLessThan(500);
      expect(err.url).toBe('https://www.compass.com/slow');
      // The hint distinguishes "bridge never came up" (role null) from
      // "bridge alive, request stalled" (role non-null).
      expect(err.hint).toMatch(/bridge is role=peer on port 37200/);
    }
    // The timeout path runs `recordFailure` inside the setTimeout
    // callback. Assert that updates the freshness counters too, so a
    // long-idle bridge that hits its first timeout is observable via
    // compass_healthcheck the same way an ok:false failure is.
    const s = t.status();
    expect(s.lastFailureAt).not.toBeNull();
    expect(s.lastFailureReason).toMatch(/^timeout: /);
    expect(s.consecutiveFailures).toBe(1);
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

  it('status() returns role + port + version + timeout + freshness fields', () => {
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
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      consecutiveFailures: 0,
    });
  });

  it('status().role reflects whatever role the inner server reports (null pre-listen)', () => {
    const t = new FetchproxyTransport({ version: '1.0.0' });
    const inner = stubInner(null);
    installInner(t, inner);
    expect(t.status().role).toBeNull();
  });
});
