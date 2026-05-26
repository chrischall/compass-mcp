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
    });
    const tools = await harness.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
  });
});
