import { describe, it, expect, vi, afterAll } from 'vitest';
import type { CompassClient } from '../../src/client.js';
import { registerHealthcheckTools } from '../../src/tools/healthcheck.js';
import {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
} from '../../src/transport-fetchproxy.js';
import { classifyBridgeError } from '@chrischall/mcp-utils/fetchproxy';
import type { BridgeStatus, BridgeProbeResult } from '../../src/transport.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

// compass_healthcheck is now factored onto mcp-utils'
// registerBridgeHealthcheckTool (the /fetchproxy subpath). These tests drive
// the factory-registered tool through the same MCP harness real callers use,
// asserting the result shape compass historically returned — plus the
// hardcoded-37149-port bug FIX (the "never bound a role" hint now reads the
// REAL configured port from the bridge snapshot).

const DEFAULT_STATUS: BridgeStatus = {
  role: 'host',
  port: 37149,
  serverVersion: '0.0.0',
  fetchTimeoutMs: 30_000,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureReason: null,
  consecutiveFailures: 0,
  lastExtensionMessageAt: null,
  keepAlive: {
    enabled: true,
    intervalMs: 25_000,
    maxIdleMs: 300_000,
    lastPingAt: null,
    totalPings: 0,
    idleSinceMs: null,
  },
  swEviction: {
    lazyReviveAttempts: 0,
    lazyReviveSuccesses: 0,
    lastEvictionDetectedAt: null,
  },
} as unknown as BridgeStatus;

/**
 * Build a stub CompassClient whose `runProbe` faithfully mirrors
 * @fetchproxy/server's real `runProbe`: run `fetchFn(probePath)`, time it,
 * classify any throw via `classifyBridgeError`, and project the (stubbed)
 * bridge snapshot into the snake-cased `bridge` block. The factory consumes
 * THIS, so the test exercises the real projection + hint ladder.
 */
function stubClient(args: {
  status?: Partial<BridgeStatus>;
  fetchHtml?: ReturnType<typeof vi.fn>;
}): CompassClient {
  const status: BridgeStatus = { ...DEFAULT_STATUS, ...(args.status ?? {}) };
  const fetchHtml = args.fetchHtml ?? vi.fn().mockResolvedValue('User-agent: *');

  const bridgeBlock: BridgeProbeResult['bridge'] = {
    role: status.role,
    port: status.port,
    server_version: status.serverVersion,
    fetch_timeout_ms: status.fetchTimeoutMs,
    last_success_at: status.lastSuccessAt,
    last_failure_at: status.lastFailureAt,
    last_failure_reason: status.lastFailureReason,
    consecutive_failures: status.consecutiveFailures,
  };

  const runProbe = vi.fn(
    async (
      fetchFn: (path: string) => Promise<unknown>,
      probePath: string
    ): Promise<BridgeProbeResult> => {
      const start = Date.now();
      try {
        await fetchFn(probePath);
        return { ok: true, elapsed_ms: Date.now() - start, bridge: bridgeBlock };
      } catch (e) {
        const kind = classifyBridgeError(e);
        const message = e instanceof Error ? e.message : String(e);
        return {
          ok: false,
          elapsed_ms: Date.now() - start,
          bridge: bridgeBlock,
          error: { kind, message },
        };
      }
    }
  );

  return {
    runProbe,
    bridgeStatus: vi.fn().mockReturnValue(status),
    fetchHtml,
  } as unknown as CompassClient;
}

let harness: Awaited<ReturnType<typeof createTestHarness>>;
afterAll(async () => {
  if (harness) await harness.close();
});

describe('compass_healthcheck tool', () => {
  it('returns ok=true when /robots.txt round-trips through the bridge', async () => {
    const client = stubClient({
      fetchHtml: vi.fn().mockResolvedValue('User-agent: *\nDisallow:\n'),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('compass_healthcheck', {});
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      ok: boolean;
      bridge: { role: string; port: number };
      probe: { url: string; status: number; body_length: number };
      hint: string;
    }>(r);
    expect(parsed.ok).toBe(true);
    expect(parsed.bridge.role).toBe('host');
    expect(parsed.probe.url).toBe('https://www.compass.com/robots.txt');
    expect(parsed.probe.status).toBe(200);
    expect(parsed.probe.body_length).toBeGreaterThan(0);
    expect(parsed.hint).toMatch(/successfully/i);
  });

  it('classifies a FetchproxyTimeoutError as kind=timeout with extension-popup hint', async () => {
    const client = stubClient({
      status: {
        role: 'peer',
        port: 37200,
        serverVersion: '1.0.0',
        fetchTimeoutMs: 25,
      },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyTimeoutError({
          url: 'https://www.compass.com/robots.txt',
          timeoutMs: 25,
          elapsedMs: 28,
          role: 'peer',
          port: 37200,
        })
      ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('compass_healthcheck', {});
    expect(r.isError).toBeFalsy(); // healthcheck reports failure in payload, not as tool error
    const parsed = parseToolResult<{
      ok: boolean;
      bridge: { role: string };
      error: { kind: string };
      hint: string;
    }>(r);
    expect(parsed.ok).toBe(false);
    expect(parsed.bridge.role).toBe('peer');
    expect(parsed.error.kind).toBe('timeout');
    expect(parsed.hint).toMatch(/extension popup/i);
  });

  it('bridge_down hint wins over the generic role=null hint when both apply', async () => {
    // Regression: a FetchproxyBridgeDownError thrown while role happened to be
    // null (possible during startup) must show the SW-eviction guidance, not
    // the "never bound a role" message.
    const client = stubClient({
      status: { role: null, port: 37149, serverVersion: '1.0.0' },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyBridgeDownError({
          url: 'https://www.compass.com/robots.txt',
          elapsedMs: 11,
          role: null,
          port: 37149,
          originalError: 'Could not establish connection.',
        })
      ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('compass_healthcheck', {});
    const parsed = parseToolResult<{ error: { kind: string }; hint: string }>(r);
    expect(parsed.error.kind).toBe('bridge_down');
    expect(parsed.hint).toMatch(/service worker/i);
    expect(parsed.hint).not.toMatch(/never bound a role/);
  });

  it('hint when role is null points at startup failure and reads the REAL configured port (not a hardcoded 37149)', async () => {
    // The hardcoded-37149-port bug FIX: the old hand-rolled hint always said
    // "confirm port 37149 isn't blocked" even when COMPASS_WS_PORT overrode it.
    // The factory's ladder reads the real port from the bridge snapshot.
    const client = stubClient({
      status: {
        role: null,
        port: 41999, // non-default port — must appear in the hint
        serverVersion: '1.0.0',
        fetchTimeoutMs: 25,
      },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyTimeoutError({
          url: 'https://www.compass.com/robots.txt',
          timeoutMs: 25,
          elapsedMs: 28,
          role: null,
          port: 41999,
        })
      ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('compass_healthcheck', {});
    const parsed = parseToolResult<{
      ok: boolean;
      bridge: { role: string | null; port: number };
      hint: string;
    }>(r);
    expect(parsed.ok).toBe(false);
    expect(parsed.bridge.role).toBeNull();
    expect(parsed.hint).toMatch(/never bound a role/);
    expect(parsed.hint).toContain('41999');
    expect(parsed.hint).not.toContain('37149');
  });

  it('classifies a bare FetchproxyProtocolError as kind=protocol (no_tab / domain_denied / etc.)', async () => {
    const { FetchproxyProtocolError } = await import('@chrischall/mcp-utils/fetchproxy');
    const client = stubClient({
      fetchHtml: vi
        .fn()
        .mockRejectedValue(
          new FetchproxyProtocolError('no_tab: extension offline')
        ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('compass_healthcheck', {});
    const parsed = parseToolResult<{ ok: boolean; error: { kind: string }; hint: string }>(r);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.kind).toBe('protocol');
    expect(parsed.hint).toMatch(/no www\.compass\.com tab is open/i);
  });

  it('classifies a FetchproxyBridgeDownError as kind=bridge_down with SW-eviction hint', async () => {
    const client = stubClient({
      status: { role: 'peer', port: 37149, serverVersion: '0.5.0' },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyBridgeDownError({
          url: 'https://www.compass.com/robots.txt',
          elapsedMs: 14,
          role: 'peer',
          port: 37149,
          originalError:
            'tab fetch failed: Error: Could not establish connection. Receiving end does not exist.',
        })
      ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('compass_healthcheck', {});
    const parsed = parseToolResult<{
      ok: boolean;
      error: { kind: string; message: string };
      hint: string;
    }>(r);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.kind).toBe('bridge_down');
    // Hint must point the operator at the extension's service worker.
    expect(parsed.hint).toMatch(/service worker/i);
  });

  it('surfaces freshness counters (last_success_at, last_failure_at, consecutive_failures) on the bridge block', async () => {
    const SUCCESS_AT = Date.parse('2026-05-25T03:39:46Z');
    const FAILURE_AT = Date.parse('2026-05-25T03:40:00Z');
    const client = stubClient({
      status: {
        lastSuccessAt: SUCCESS_AT,
        lastFailureAt: FAILURE_AT,
        lastFailureReason: 'Could not establish connection.',
        consecutiveFailures: 3,
      },
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('compass_healthcheck', {});
    const parsed = parseToolResult<{
      bridge: {
        last_success_at: number | null;
        last_failure_at: number | null;
        last_failure_reason: string | null;
        consecutive_failures: number;
      };
    }>(r);
    expect(parsed.bridge.last_success_at).toBe(SUCCESS_AT);
    expect(parsed.bridge.last_failure_at).toBe(FAILURE_AT);
    expect(parsed.bridge.last_failure_reason).toMatch(/Could not establish/);
    expect(parsed.bridge.consecutive_failures).toBe(3);
  });

  it('surfaces last_extension_message_at on the bridge block (0.8.0 liveness signal)', async () => {
    // last_extension_message_at is omitted by runProbe's projection; the
    // factory reads it off transport.status() (here client.bridgeStatus()).
    const LAST_MSG = Date.parse('2026-05-25T03:39:46Z');
    const client = stubClient({
      status: { lastExtensionMessageAt: LAST_MSG },
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('compass_healthcheck', {});
    const parsed = parseToolResult<{
      bridge: { last_extension_message_at: number | null };
    }>(r);
    expect(parsed.bridge.last_extension_message_at).toBe(LAST_MSG);
  });

  it('surfaces .hint from FetchproxyBridgeDownError as error.bridge_hint', async () => {
    const client = stubClient({
      status: { role: 'host', port: 37149, serverVersion: '0.8.0' },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyBridgeDownError({
          url: 'https://www.compass.com/robots.txt',
          retryAttempted: true,
          role: 'host',
          port: 37149,
          originalError: 'Could not establish connection.',
        })
      ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('compass_healthcheck', {});
    const parsed = parseToolResult<{
      error: { kind: string; bridge_hint?: string };
    }>(r);
    expect(parsed.error.kind).toBe('bridge_down');
    expect(parsed.error.bridge_hint).toBeTruthy();
    expect(typeof parsed.error.bridge_hint).toBe('string');
    expect(parsed.error.bridge_hint!.length).toBeGreaterThan(0);
  });

  it('classifies an unrelated error as kind=unknown', async () => {
    // The factory maps fetchproxy's raw 'other' kind onto the envelope's
    // 'unknown' label.
    const client = stubClient({
      fetchHtml: vi.fn().mockRejectedValue(new Error('something else')),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('compass_healthcheck', {});
    const parsed = parseToolResult<{ ok: boolean; error: { kind: string } }>(r);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.kind).toBe('unknown');
  });
});
