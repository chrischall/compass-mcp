// Context-group hints (`_meta.mint`, the mcp-host context-groups contract),
// read off the MCP wire (tools/list) — what a host sees — so the shared
// registrars (realty-core calculators, the mcp-utils session trio) are held to
// the same rules as the tools this repo registers itself.
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

type Mint = Record<string, unknown>;
interface Listed {
  name: string;
  inputSchema: { properties?: Record<string, { enum?: unknown[] }> };
  annotations?: { readOnlyHint?: boolean };
  _meta?: { mint?: Mint };
}

const mockClient = { fetchHtml: vi.fn(), fetchJson: vi.fn() } as unknown as CompassClient;

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const CANONICAL_INTENTS = ['whats-new', 'whats-due', 'whats-on'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];

/**
 * The intent every tool declares — this table is the assertion, so a new tool
 * cannot skip the decision. Compass is a listings search: nothing here answers
 * "what's new / due / on for me" without a location the person has not said,
 * so every read is a lookup and nothing is canonical.
 */
const EXPECTED_INTENT: Record<string, string> = {
  compass_search_properties: 'lookup',
  compass_get_property: 'lookup',
  compass_get_property_photos: 'lookup',
  compass_get_price_history: 'lookup',
  compass_compare_properties: 'lookup',
  compass_bulk_get: 'lookup',
  compass_get_comparable_rentals: 'lookup',
  compass_get_saved_homes: 'lookup',
  compass_get_saved_searches: 'lookup',
  compass_calculate_mortgage: 'lookup',
  compass_calculate_affordability: 'lookup',
  compass_get_by_address: 'lookup',
  compass_resolve_addresses: 'lookup',
  compass_get_agent_listings: 'lookup',
  compass_get_session_context: 'lookup',
  compass_register_session: 'other',
  compass_set_active_session: 'other',
};

let harness: Awaited<ReturnType<typeof createTestHarness>>;
let tools: Listed[];

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
  tools = (await harness.client.listTools()).tools as Listed[];
});

afterAll(async () => {
  if (harness) await harness.close();
});

const hinted = (): Listed[] => tools.filter((t) => t.name !== 'compass_healthcheck');

describe('_meta.mint on tools/list', () => {
  it('names every served tool except the healthcheck', () => {
    expect(tools.map((t) => t.name).sort()).toEqual(
      [...Object.keys(EXPECTED_INTENT), 'compass_healthcheck'].sort()
    );
  });

  it.each(Object.entries(EXPECTED_INTENT))('%s declares domain home and intent %s', (name, intent) => {
    const mint = tools.find((t) => t.name === name)?._meta?.mint;
    expect(mint, name).toBeDefined();
    expect(mint!.domain).toBe('home');
    expect(mint!.intent).toBe(intent);
  });

  it('the healthcheck joins no group', () => {
    expect(tools.find((t) => t.name === 'compass_healthcheck')?._meta?.mint).toBeUndefined();
  });

  it('every hint is shaped per the host contract', () => {
    for (const t of hinted()) {
      const mint = t._meta!.mint!;
      const props = t.inputSchema.properties ?? {};
      expect(Object.keys(mint).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
      expect(DOMAINS, t.name).toContain(mint.domain);
      expect(INTENTS, t.name).toContain(mint.intent);
      if ('subject' in mint) expect(props, t.name).toHaveProperty(mint.subject as string);
      if ('when' in mint) {
        const when = mint.when as Record<string, string>;
        expect(Object.keys(when).sort(), t.name).toEqual(['end', 'start']);
        expect(props, t.name).toHaveProperty(when.start);
        expect(props, t.name).toHaveProperty(when.end);
      }
      if ('aliases' in mint) {
        const aliases = mint.aliases as string[];
        expect(aliases.length, t.name).toBeGreaterThan(0);
        expect(aliases.length, t.name).toBeLessThanOrEqual(8);
        for (const a of aliases) {
          expect(a.length, t.name).toBeLessThanOrEqual(40);
          expect(a, t.name).toBe(a.toLowerCase());
          expect(a, t.name).not.toMatch(/^compass_/);
        }
      }
    }
  });

  it('canonical only on a read-only whats-new/due/on tool, at most one per intent, with a brief view', () => {
    const canonical = hinted().filter((t) => t._meta!.mint!.canonical !== undefined);
    const perIntent = new Map<string, number>();
    for (const t of canonical) {
      const mint = t._meta!.mint!;
      expect(mint.canonical, t.name).toBe(true);
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(CANONICAL_INTENTS, t.name).toContain(mint.intent);
      expect(t.inputSchema.properties?.view?.enum, t.name).toContain('brief');
      perIntent.set(mint.intent as string, (perIntent.get(mint.intent as string) ?? 0) + 1);
    }
    for (const [intent, n] of perIntent) expect(n, intent).toBe(1);
  });

  it('marks nothing canonical: compass answers no what-is-new/due/on question for a person', () => {
    expect(hinted().filter((t) => t._meta!.mint!.canonical).map((t) => t.name)).toEqual([]);
  });

  it('declares no subject: compass has no listable set of the person’s subjects', () => {
    expect(hinted().filter((t) => 'subject' in t._meta!.mint!).map((t) => t.name)).toEqual([]);
  });

  it('gives the search the words a person says for it', () => {
    expect(tools.find((t) => t.name === 'compass_search_properties')?._meta?.mint?.aliases).toEqual(
      expect.arrayContaining(['homes for sale', 'listings'])
    );
  });
});

describe('withMintMeta', () => {
  it('adds the named tool’s hint, keeps its other _meta, and passes every other tool through untouched', async () => {
    const { withMintMeta, homeMeta } = await import('../src/tools/hints.js');
    const { z } = await import('zod');
    const h = await createTestHarness((server) => {
      const view = withMintMeta(server, { named: homeMeta('lookup') });
      const cfg = (meta?: Record<string, unknown>) => ({ description: 'x', inputSchema: z.object({}), ...(meta ? { _meta: meta } : {}) });
      const cb = async () => ({ content: [] });
      view.registerTool('named', cfg({ other: 1 }), cb);
      view.registerTool('plain', cfg(), cb);
      expect(view.isConnected()).toBe(false);
    });
    const listed = (await h.client.listTools()).tools as Listed[];
    await h.close();
    expect(listed.find((t) => t.name === 'named')?._meta).toEqual({ other: 1, mint: { domain: 'home', intent: 'lookup' } });
    expect(listed.find((t) => t.name === 'plain')?._meta).toBeUndefined();
  });
});
