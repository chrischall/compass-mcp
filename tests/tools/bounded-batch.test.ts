import { describe, it, expect, vi } from 'vitest';
import type { CompassClient } from '../../src/client.js';
import {
  DeadlineAbandonedError,
  guardClient,
  pendingMessage,
} from '../../src/tools/bounded-batch.js';

describe('guardClient (fleet-audit#927)', () => {
  const make = () => {
    const fetchHtml = vi.fn(async () => '<html/>');
    const fetchJson = vi.fn(async () => ({ ok: true }));
    const client = {
      fetchHtml,
      fetchJson,
      label: 'x',
      bridgeStatus(this: { label: string }) {
        return this.label;
      },
    } as unknown as CompassClient;
    return { client, fetchHtml, fetchJson };
  };

  it('returns the client untouched when there is no signal', () => {
    const { client } = make();
    expect(guardClient(client, undefined)).toBe(client);
  });

  it('passes calls through while the signal is live', async () => {
    const { client, fetchHtml, fetchJson } = make();
    const g = guardClient(client, new AbortController().signal);
    await expect(g.fetchHtml('/a')).resolves.toBe('<html/>');
    await expect(g.fetchJson('/b', { method: 'POST' })).resolves.toEqual({ ok: true });
    expect(fetchHtml).toHaveBeenCalledWith('/a');
    expect(fetchJson).toHaveBeenCalledWith('/b', { method: 'POST' });
    // Unguarded methods keep their `this` binding.
    expect(g.bridgeStatus()).toBe('x');
  });

  it('refuses to dial the bridge once the signal is aborted', async () => {
    const { client, fetchHtml, fetchJson } = make();
    const ac = new AbortController();
    const g = guardClient(client, ac.signal);
    ac.abort();
    await expect(g.fetchHtml('/a')).rejects.toBeInstanceOf(DeadlineAbandonedError);
    await expect(g.fetchJson('/b')).rejects.toBeInstanceOf(DeadlineAbandonedError);
    expect(fetchHtml).not.toHaveBeenCalled();
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('pending message names the tool and says it is not a miss', () => {
    const m = pendingMessage('compass_bulk_get');
    expect(m).toContain('compass_bulk_get');
    expect(m).toMatch(/NOT a missing listing/);
  });
});
