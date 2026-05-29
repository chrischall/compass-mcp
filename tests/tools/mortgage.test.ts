import { describe, it, expect, afterAll } from 'vitest';
import {
  registerMortgageTools,
  toCompassMortgage,
} from '../../src/tools/mortgage.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

let harness: Awaited<ReturnType<typeof createTestHarness>>;
afterAll(async () => {
  if (harness) await harness.close();
});

describe('toCompassMortgage adapter shape (realty-core → compass)', () => {
  const breakdown = {
    home_price: 1_000_000,
    down_payment: 200_000,
    loan_amount: 800_000,
    monthly_principal_interest: 5057.07,
    monthly_property_tax: 916.67,
    monthly_insurance: 150,
    monthly_hoa: 0,
    monthly_pmi: 0,
    monthly_total: 6123.74,
    total_interest_paid: 1_020_545.2,
    total_paid_over_loan: 1_820_545.2,
    loan_term_years: 30,
    interest_rate: 6.5,
    ltv_percent: 80,
  };

  it('maps ltv_percent (0..100) → ltv (0..1 ratio)', () => {
    expect(toCompassMortgage(breakdown).ltv).toBe(0.8);
  });

  it('maps monthly_total → monthly_total_piti and total_interest_paid → total_interest_over_term', () => {
    const out = toCompassMortgage(breakdown);
    expect(out.monthly_total_piti).toBe(6123.74);
    expect(out.total_interest_over_term).toBe(1_020_545.2);
  });

  it('drops total_paid_over_loan and the interest_rate echo', () => {
    const out = toCompassMortgage(breakdown) as Record<string, unknown>;
    expect(out.total_paid_over_loan).toBeUndefined();
    expect(out.interest_rate).toBeUndefined();
    expect(out.monthly_total).toBeUndefined();
    expect(out.ltv_percent).toBeUndefined();
  });

  it('passes the remaining cells through unchanged', () => {
    const out = toCompassMortgage(breakdown);
    expect(out.home_price).toBe(1_000_000);
    expect(out.down_payment).toBe(200_000);
    expect(out.loan_amount).toBe(800_000);
    expect(out.monthly_principal_interest).toBe(5057.07);
    expect(out.monthly_property_tax).toBe(916.67);
    expect(out.monthly_insurance).toBe(150);
    expect(out.monthly_hoa).toBe(0);
    expect(out.monthly_pmi).toBe(0);
    expect(out.loan_term_years).toBe(30);
  });
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
