import { describe, it, expect, afterAll } from 'vitest';
import { registerMortgageTools } from '../../src/tools/mortgage.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

let harness: Awaited<ReturnType<typeof createTestHarness>>;
afterAll(async () => {
  if (harness) await harness.close();
});

describe('compass_calculate_mortgage tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerMortgageTools(server)
    );
  });

  it('returns PITI breakdown for a 20%-down loan at 6.5% / 30yr', async () => {
    const r = await harness.callTool('compass_calculate_mortgage', {
      home_price: 1_000_000,
      interest_rate: 6.5,
      down_payment_percent: 20,
      property_tax_rate: 1.1,
      insurance_annual: 1800,
    });
    const parsed = parseToolResult<{
      loan_amount: number;
      monthly_principal_interest: number;
      monthly_total_piti: number;
      total_interest_over_term: number;
    }>(r);
    expect(parsed.loan_amount).toBe(800000);
    // ~6.5% / 30yr / 800K loan should be ~$5057/mo
    expect(parsed.monthly_principal_interest).toBeGreaterThan(4900);
    expect(parsed.monthly_principal_interest).toBeLessThan(5200);
    expect(parsed.monthly_total_piti).toBeGreaterThan(parsed.monthly_principal_interest);
    expect(parsed.total_interest_over_term).toBeGreaterThan(800_000);
  });

  it('applies PMI when LTV > 80% and pmi_rate provided', async () => {
    const r = await harness.callTool('compass_calculate_mortgage', {
      home_price: 500_000,
      interest_rate: 7,
      down_payment_percent: 10,
      pmi_rate: 1,
    });
    const parsed = parseToolResult<{ monthly_pmi: number }>(r);
    expect(parsed.monthly_pmi).toBeGreaterThan(0);
  });
});
