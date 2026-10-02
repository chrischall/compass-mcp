import { describe, it, expect, afterAll } from 'vitest';
import {
  computeAffordability,
  registerAffordabilityTools,
} from '../../src/tools/affordability.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

let harness: Awaited<ReturnType<typeof createTestHarness>>;
afterAll(async () => {
  if (harness) await harness.close();
});

describe('computeAffordability', () => {
  it('returns a reasonable max purchase price under 28/36 DTI', () => {
    const out = computeAffordability({
      monthly_income: 12000,
      monthly_debts: 600,
      down_payment: 120000,
      interest_rate: 6.5,
    });
    expect(out.max_home_price).toBeGreaterThan(400000);
    expect(out.max_home_price).toBeLessThan(700000);
    expect(out.binding_constraint).toBe('front_end');
    expect(out.loan_amount).toBe(
      Math.round((out.max_home_price - out.down_payment) * 100) / 100
    );
  });

  it('switches binding constraint to back_end when debts are heavy', () => {
    const out = computeAffordability({
      monthly_income: 12000,
      monthly_debts: 3000, // big car + student loans
      down_payment: 100000,
      interest_rate: 6.5,
    });
    expect(out.binding_constraint).toBe('back_end');
  });
});

describe('compass_calculate_affordability tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerAffordabilityTools(server)
    );
  });

  it('returns the JSON-serialized AffordabilityResult', async () => {
    const r = await harness.callTool('compass_calculate_affordability', {
      monthly_income: 12000,
      monthly_debts: 600,
      down_payment: 120000,
      interest_rate: 6.5,
    });
    expect(r.isError).toBeFalsy();
    const parsed = parseToolResult<{
      max_home_price: number;
      binding_constraint: string;
    }>(r);
    expect(parsed.max_home_price).toBeGreaterThan(400000);
    expect(parsed.binding_constraint).toBe('front_end');
  });
});

describe('compass_calculate_affordability schema caps (realty-core shared registrar, fleet-audit#1090)', () => {
  it('advertises loan_term_years.maximum = MAX_LOAN_TERM_YEARS', async () => {
    const { MAX_LOAN_TERM_YEARS } = await import('@chrischall/realty-core');
    const { registerAffordabilityTools } = await import('../../src/tools/affordability.js');
    const { createTestHarness } = await import('@chrischall/mcp-utils/test');
    const th = await createTestHarness((server) => registerAffordabilityTools(server));
    try {
      const { tools } = await th.client.listTools();
      const props = tools.find((t) => t.name === 'compass_calculate_affordability')!.inputSchema
        .properties as Record<string, { maximum?: number }>;
      expect(props.loan_term_years.maximum).toBe(MAX_LOAN_TERM_YEARS);
    } finally {
      await th.close();
    }
  });
});
