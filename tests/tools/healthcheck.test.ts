import { describe, it, expect, vi, afterAll } from 'vitest';
import type { CompassClient } from '../../src/client.js';
import { registerHealthcheckTools } from '../../src/tools/healthcheck.js';
import {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
} from '../../src/transport-fetchproxy.js';
import type { BridgeStatus } from '../../src/transport.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

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
};

function stubClient(args: {
  status?: Partial<BridgeStatus>;
  fetchHtml?: ReturnType<typeof vi.fn>;
}): CompassClient {
  return {
    bridgeStatus: vi
      .fn()
      .mockReturnValue({ ...DEFAULT_STATUS, ...(args.status ?? {}) }),
    fetchHtml: args.fetchHtml ?? vi.fn().mockResolvedValue('User-agent: *'),
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

  it('classifies a FetchproxyTimeoutError as kind=timeout with role-specific hint', async () => {
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
      error: { kind: string; role_at_failure: string };
      hint: string;
    }>(r);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.kind).toBe('timeout');
    expect(parsed.error.role_at_failure).toBe('peer');
    expect(parsed.hint).toMatch(/extension popup/i);
  });

  it('bridge_down hint wins over the generic role=null hint when both apply', async () => {
    // Regression: the previous hintFor ordering checked role===null
    // first, so a FetchproxyBridgeDownError thrown while role happened
    // to be null (technically possible during startup) showed the
    // wrong message ("bridge never bound a role") instead of the
    // SW-eviction guidance.
    const client = stubClient({
      status: {
        role: null,
        port: 37149,
        serverVersion: '1.0.0',
      },
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

  it('hint when role is null points at startup failure, not extension issue', async () => {
    const client = stubClient({
      status: {
        role: null,
        port: 37149,
        serverVersion: '1.0.0',
        fetchTimeoutMs: 25,
      },
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyTimeoutError({
          url: 'https://www.compass.com/robots.txt',
          timeoutMs: 25,
          elapsedMs: 28,
          role: null,
          port: 37149,
        })
      ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('compass_healthcheck', {});
    const parsed = parseToolResult<{
      ok: boolean;
      error: { role_at_failure: string | null };
      hint: string;
    }>(r);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.role_at_failure).toBeNull();
    expect(parsed.hint).toMatch(/never bound a role/);
  });

  it('classifies a bare FetchproxyProtocolError as kind=protocol (no_tab / domain_denied / etc.)', async () => {
    // classifyBridgeError vocabulary: the base FetchproxyProtocolError
    // (not a timeout / bridge_down / http subclass) maps to 'protocol'.
    // Pre-0.8.0 this arm was labelled 'transport' in compass; 0.8.0
    // standardises on 'protocol' across the cohort via the helper.
    const { FetchproxyProtocolError } = await import('@fetchproxy/server');
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
    expect(parsed.hint).toMatch(/no compass\.com tab is open/i);
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
    // Hint must point the operator at the right place: the extension's
    // service worker, not the MCP process and not Compass itself.
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
    // 0.8.0 added bridgeHealth().lastExtensionMessageAt — wall-clock of
    // the most recent inner frame from the extension, distinct from
    // per-call success/failure. Surface it in the tool response so an
    // operator can tell "extension still answering" from "this call
    // failed".
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
    // 0.8.0 added `.hint` to FetchproxyBridgeDownError carrying the
    // server's own actionable next-step (independent of compass's
    // hint composition). Surface it through so the operator sees the
    // exact text the bridge author intended.
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

  it('reads role/port/elapsed_ms directly off the typed error (0.8.0 fields)', async () => {
    // 0.8.0 hangs role/port/elapsedMs on the typed error itself, so
    // we don't have to consult bridgeStatus() to know where the
    // failure happened. The healthcheck surface should use those.
    // Probe a divergence case: simulate the status() snapshot drifting
    // away from the role recorded on the error, and assert the
    // response prefers the error's own role/port (the source of truth
    // for THIS call).
    const client = stubClient({
      status: { role: null, port: 99999 }, // intentionally wrong
      fetchHtml: vi.fn().mockRejectedValue(
        new FetchproxyTimeoutError({
          url: 'https://www.compass.com/robots.txt',
          timeoutMs: 25,
          elapsedMs: 27,
          role: 'host',
          port: 37149,
        })
      ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('compass_healthcheck', {});
    const parsed = parseToolResult<{
      probe: { elapsed_ms: number };
      error: {
        kind: string;
        role_at_failure: 'host' | 'peer' | null;
        port_at_failure?: number;
        elapsed_ms?: number;
      };
    }>(r);
    expect(parsed.error.kind).toBe('timeout');
    // Error's own role/port win when present (source of truth for this throw).
    expect(parsed.error.role_at_failure).toBe('host');
    expect(parsed.error.port_at_failure).toBe(37149);
    expect(parsed.error.elapsed_ms).toBe(27);
  });

  it('classifies an unrelated error as kind=other', async () => {
    const client = stubClient({
      fetchHtml: vi.fn().mockRejectedValue(new Error('something else')),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('compass_healthcheck', {});
    const parsed = parseToolResult<{ ok: boolean; error: { kind: string } }>(r);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.kind).toBe('other');
  });
});
