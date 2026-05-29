import { describe, it, expect, afterAll } from 'vitest';
import type { CompassClient } from '../../src/client.js';
import { registerSavedTools } from '../../src/tools/saved.js';
import { createTestHarness } from '../helpers.js';

let harness: Awaited<ReturnType<typeof createTestHarness>>;
afterAll(async () => {
  if (harness) await harness.close();
});

const mockClient = {} as unknown as CompassClient;

describe('compass_get_saved_homes (placeholder)', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerSavedTools(server, mockClient)
    );
  });

  it('throws a clear "not yet supported" error', async () => {
    const r = await harness.callTool('compass_get_saved_homes', {});
    expect(r.isError).toBeTruthy();
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/0\.10\.0 doesn['’]t yet wire/);
  });

  it('compass_get_saved_searches throws the same way', async () => {
    const r = await harness.callTool('compass_get_saved_searches', {});
    expect(r.isError).toBeTruthy();
  });
});
