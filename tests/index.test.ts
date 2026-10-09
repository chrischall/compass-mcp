// Smoke test for the full tool surface. Verifies every compass_* tool is
// registered and visible over the MCP wire — catches "forgot to wire it
// up in index.ts" mistakes that the per-tool tests miss.
import { describe, it, expect, afterAll, vi } from 'vitest';
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
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSessionRegistry } from '@chrischall/mcp-utils/session';
import { createTestHarness } from './helpers.js';

const mockClient = {
  fetchHtml: vi.fn(),
  fetchJson: vi.fn(),
} as unknown as CompassClient;

const EXPECTED_TOOLS = [
  'compass_search_properties',
  'compass_get_property',
  'compass_get_property_photos',
  'compass_get_price_history',
  'compass_compare_properties',
  'compass_get_saved_homes',
  'compass_get_saved_searches',
  'compass_calculate_mortgage',
  'compass_calculate_affordability',
  'compass_healthcheck',
  'compass_get_by_address',
  'compass_get_agent_listings',
  'compass_bulk_get',
  'compass_resolve_addresses',
  'compass_get_comparable_rentals',
  'compass_register_session',
  'compass_set_active_session',
  'compass_get_session_context',
];

let harness: Awaited<ReturnType<typeof createTestHarness>>;
afterAll(async () => {
  if (harness) await harness.close();
});

describe('tool registration', () => {
  it('registers every advertised compass_* tool', async () => {
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
    const tools = await harness.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
  });
});

// fleet-audit#383: Claude Desktop shows the .mcpb manifest's tools[] at
// install time, so it must list exactly the registered tools.
describe('manifest.json', () => {
  const manifest = JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'manifest.json'),
      'utf8'
    )
  ) as { description: string; tools: { name: string; description: string }[] };

  it('advertises exactly the registered tools', () => {
    expect(manifest.tools.map((t) => t.name).sort()).toEqual(
      [...EXPECTED_TOOLS].sort()
    );
    for (const t of manifest.tools) expect(t.description, t.name).toBeTruthy();
  });

  it('promises no feature the server lacks', () => {
    expect(manifest.description).not.toMatch(/market report/i);
    expect(JSON.stringify(manifest.tools)).not.toMatch(/property_id\+listing_id/);
  });
});

// fleet-audit#384: these strings go straight to the model. The sha path
// is a direct `/listing/<sha>/view` fetch (no site-search round trip), and
// the package version is not something the saved-tools error should pin.
describe('tool descriptions', () => {
  it('no sha parameter claims a site-search slug lookup', async () => {
    const h = await createTestHarness((server) => {
      registerPropertyTools(server, mockClient);
      registerHistoryTools(server, mockClient);
      registerPhotosTools(server, mockClient);
      registerCompareTools(server, mockClient);
      registerComparableRentalsTools(server, mockClient);
    });
    try {
      const { tools } = await h.client.listTools();
      const stale = tools
        .filter((t) => /site search|slug is resolved internally/i.test(JSON.stringify(t)))
        .map((t) => t.name);
      expect(stale).toEqual([]);
      for (const t of tools) {
        const sha = JSON.stringify(
          (t.inputSchema as { properties?: Record<string, unknown> }).properties
        );
        expect(sha, t.name).toMatch(/\/listing\/<sha>\/view/);
      }
    } finally {
      await h.close();
    }
  });

  it('the saved-tools error does not hard-code a package version', async () => {
    const h = await createTestHarness((server) => registerSavedTools(server, mockClient));
    try {
      const r = await h.callTool('compass_get_saved_homes', {});
      const text = (r.content[0] as { text: string }).text;
      expect(text).not.toMatch(/\d+\.\d+\.\d+/);
      expect(text).toMatch(/doesn['’]t yet wire up saved listings/);
    } finally {
      await h.close();
    }
  });
});
