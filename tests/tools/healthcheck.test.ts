import { describe, it, expect, vi, afterAll } from 'vitest';
import type { CompassClient } from '../../src/client.js';
import { registerHealthcheckTools } from '../../src/tools/healthcheck.js';
import { FetchproxyTimeoutError } from '../../src/transport-fetchproxy.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

function stubClient(args: {
  status?: {
    role: 'host' | 'peer' | null;
    port: number;
    serverVersion: string;
    fetchTimeoutMs: number;
  };
  fetchHtml?: ReturnType<typeof vi.fn>;
}): CompassClient {
  return {
    bridgeStatus: vi.fn().mockReturnValue(
      args.status ?? {
        role: 'host',
        port: 37149,
        serverVersion: '0.0.0',
        fetchTimeoutMs: 30_000,
      }
    ),
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

  it('classifies a plain "fetchproxy transport error" as kind=transport', async () => {
    const client = stubClient({
      fetchHtml: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'fetchproxy transport error after 12ms (role=host): extension offline'
          )
        ),
    });
    harness = await createTestHarness((server) =>
      registerHealthcheckTools(server, client)
    );
    const r = await harness.callTool('compass_healthcheck', {});
    const parsed = parseToolResult<{ ok: boolean; error: { kind: string }; hint: string }>(r);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.kind).toBe('transport');
    expect(parsed.hint).toMatch(/no compass\.com tab is open/i);
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
