import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { CompassClient } from '../../src/client.js';
import type { BridgeStatus } from '../../src/transport.js';
import { registerSessionTools } from '../../src/tools/session.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

function makeBridgeStatus(overrides: Partial<BridgeStatus> = {}): BridgeStatus {
  return {
    role: 'host',
    port: 37149,
    serverVersion: '0.7.0',
    fetchTimeoutMs: 30_000,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureReason: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

const mockBridgeStatus = vi.fn();
const mockClient = {
  bridgeStatus: mockBridgeStatus,
  listSessions: vi.fn(),
  getActiveSessionId: vi.fn(),
  setActiveSession: vi.fn(),
} as unknown as CompassClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

describe('compass_get_session_context', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerSessionTools(server, mockClient)
    );
  });

  it('lists all registered sessions + the active_session_id (#42)', async () => {
    const sessions = [
      { sessionId: 'session-1', status: makeBridgeStatus({ role: 'host' }) },
      { sessionId: 'session-2', status: makeBridgeStatus({ role: 'peer', port: 37150 }) },
    ];
    (mockClient.listSessions as ReturnType<typeof vi.fn>).mockReturnValue(sessions);
    (mockClient.getActiveSessionId as ReturnType<typeof vi.fn>).mockReturnValue('session-1');

    const r = await harness.callTool('compass_get_session_context', {});
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      active_session_id: string;
      sessions: Array<{ session_id: string; role: string; port: number }>;
    }>(r);
    expect(parsed.active_session_id).toBe('session-1');
    expect(parsed.sessions).toHaveLength(2);
    expect(parsed.sessions.map((s) => s.session_id)).toEqual(['session-1', 'session-2']);
    expect(parsed.sessions[0].role).toBe('host');
    expect(parsed.sessions[1].role).toBe('peer');
  });

  it('reduces cleanly to a one-entry sessions[] for the single-session case', async () => {
    (mockClient.listSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      { sessionId: 'session-1', status: makeBridgeStatus() },
    ]);
    (mockClient.getActiveSessionId as ReturnType<typeof vi.fn>).mockReturnValue('session-1');

    const r = await harness.callTool('compass_get_session_context', {});
    const parsed = parseToolResult<{
      active_session_id: string;
      sessions: Array<{ session_id: string }>;
    }>(r);
    expect(parsed.active_session_id).toBe('session-1');
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].session_id).toBe('session-1');
  });
});

describe('compass_set_active_session', () => {
  it('forwards the session id to client.setActiveSession and echoes the new active (#41)', async () => {
    (mockClient.setActiveSession as ReturnType<typeof vi.fn>).mockImplementation(
      (id: string) => {
        (mockClient.getActiveSessionId as ReturnType<typeof vi.fn>).mockReturnValue(id);
      }
    );
    (mockClient.listSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      { sessionId: 'session-1', status: makeBridgeStatus() },
      { sessionId: 'session-2', status: makeBridgeStatus({ role: 'peer' }) },
    ]);
    const r = await harness.callTool('compass_set_active_session', {
      session_id: 'session-2',
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{ active_session_id: string }>(r);
    expect(parsed.active_session_id).toBe('session-2');
    expect(mockClient.setActiveSession).toHaveBeenCalledWith('session-2');
  });

  it('throws a clear error for an unknown session_id', async () => {
    (mockClient.setActiveSession as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        throw new Error('unknown session: session-99');
      }
    );
    const r = await harness.callTool('compass_set_active_session', {
      session_id: 'session-99',
    });
    expect(r.isError).toBeTruthy();
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/unknown session/i);
  });
});
