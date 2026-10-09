// Fleet annotation meta-test, read off the MCP wire (tools/list) rather than
// a hand-kept list, so a shared registrar (the mcp-utils session trio, the
// realty-core calculators, the bridge healthcheck) is checked exactly as a
// client sees it.
//
// `destructiveHint` DEFAULTS TO TRUE whenever readOnlyHint is false, so a
// write that forgets to declare it is published as destructive and nothing
// else fails — a considered `false` and a forgotten one look identical
// unless something asserts the key is present.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { CompassClient } from '../src/client.js';
import { registerSearchTools } from '../src/tools/search.js';
import { registerPropertyTools } from '../src/tools/properties.js';
import { registerSavedTools } from '../src/tools/saved.js';
import { registerMortgageTools } from '../src/tools/mortgage.js';
import { registerHistoryTools } from '../src/tools/history.js';
import { registerCompareTools } from '../src/tools/compare.js';
import { registerAffordabilityTools } from '../src/tools/affordability.js';
import { registerPhotosTools } from '../src/tools/photos.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { registerByAddressTools } from '../src/tools/by-address.js';
import { registerAgentListingsTools } from '../src/tools/agent-listings.js';
import { registerSessionTools } from '../src/tools/session.js';
import { registerComparableRentalsTools } from '../src/tools/comparable-rentals.js';
import { registerBulkGetTools } from '../src/tools/bulk-get.js';
import { registerResolveAddressesTools } from '../src/tools/resolve-addresses.js';
import { createSessionRegistry } from '@chrischall/mcp-utils/session';
import { createTestHarness } from './helpers.js';

const mockClient = {
  fetchHtml: vi.fn(),
  fetchJson: vi.fn(),
} as unknown as CompassClient;

interface Ann {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  openWorldHint?: unknown;
}

let harness: Awaited<ReturnType<typeof createTestHarness>>;
let annotations: Record<string, Ann | undefined>;

beforeAll(async () => {
  harness = await createTestHarness((server) => {
    registerSearchTools(server, mockClient);
    registerPropertyTools(server, mockClient);
    registerSavedTools(server, mockClient);
    registerMortgageTools(server);
    registerHistoryTools(server, mockClient);
    registerCompareTools(server, mockClient);
    registerAffordabilityTools(server);
    registerPhotosTools(server, mockClient);
    registerHealthcheckTools(server, mockClient);
    registerByAddressTools(server, mockClient);
    registerAgentListingsTools(server, mockClient);
    registerBulkGetTools(server, mockClient);
    registerResolveAddressesTools(server, mockClient);
    registerComparableRentalsTools(server, mockClient);
    registerSessionTools(server, createSessionRegistry());
  });
  const { tools } = await harness.client.listTools();
  annotations = Object.fromEntries(tools.map((t) => [t.name, t.annotations as Ann | undefined]));
});

afterAll(async () => {
  if (harness) await harness.close();
});

// Process-local tools: the realty-core calculators and the in-memory session
// registry. Everything else reaches compass.com through the browser bridge.
const LOCAL = new Set([
  'compass_calculate_mortgage',
  'compass_calculate_affordability',
  'compass_get_session_context',
  'compass_register_session',
  'compass_set_active_session',
]);

// Every write, pinned to its truthful destructive classification.
// Both only touch the process-local, label-only session registry, reach no
// one, and the one piece of prior state they replace (which session is
// active) is restored by compass_set_active_session.
const WRITES: Record<string, boolean> = {
  compass_register_session: false,
  compass_set_active_session: false,
};

describe('tool annotations', () => {
  it('covers the full surface (guards against a registrar being dropped here)', () => {
    expect(Object.keys(annotations)).toHaveLength(18);
  });

  it('every tool sets an explicit boolean readOnlyHint', () => {
    const missing = Object.entries(annotations)
      .filter(([, a]) => typeof a?.readOnlyHint !== 'boolean')
      .map(([n]) => n);
    expect(missing).toEqual([]);
  });

  it('every write sets an explicit boolean destructiveHint', () => {
    const missing = Object.entries(annotations)
      .filter(([, a]) => a?.readOnlyHint === false && typeof a?.destructiveHint !== 'boolean')
      .map(([n]) => n);
    expect(missing).toEqual([]);
  });

  it('no read claims to be destructive', () => {
    const bad = Object.entries(annotations)
      .filter(([, a]) => a?.readOnlyHint === true && a?.destructiveHint === true)
      .map(([n]) => n);
    expect(bad).toEqual([]);
  });

  it('the writes are exactly the pinned set, with their pinned classification', () => {
    const writes = Object.fromEntries(
      Object.entries(annotations)
        .filter(([, a]) => a?.readOnlyHint === false)
        .map(([n, a]) => [n, a?.destructiveHint])
    );
    expect(writes).toEqual(WRITES);
  });

  it('openWorldHint is explicit: false only for process-local tools', () => {
    const wrong = Object.entries(annotations)
      .filter(([n, a]) => a?.openWorldHint !== !LOCAL.has(n))
      .map(([n]) => n);
    expect(wrong).toEqual([]);
  });
});
