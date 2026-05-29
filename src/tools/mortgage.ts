import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  calculateMortgage,
  type MortgageInput,
  type MortgageBreakdown,
} from '@chrischall/realty-core';
import { textResult } from '../mcp.js';

/**
 * Local-only mortgage / PITI calculator. No network — fully
 * deterministic. The PITI math is the cohort-canonical
 * `calculateMortgage` (realty-core) — the same helper zillow / redfin /
 * homes / onehome share — so the formula can't drift across the cohort.
 *
 * realty-core's `MortgageBreakdown` carries the zillow-shaped union
 * (`ltv_percent` as 0..100, `monthly_total`, `total_interest_paid`,
 * `total_paid_over_loan`, `interest_rate`). compass's tool surface
 * predates that and is leaner, so this thin adapter maps the canonical
 * shape back onto compass's historical output, byte-for-byte:
 *
 *   realty-core            →  compass
 *   ─────────────────────────────────────────────
 *   ltv_percent (0..100)   →  ltv (0..1 ratio)
 *   monthly_total          →  monthly_total_piti
 *   total_interest_paid    →  total_interest_over_term
 *   (total_paid_over_loan)    dropped
 *   (interest_rate echo)      dropped
 *
 * everything else (home_price, down_payment, loan_amount, the monthly_*
 * cells, loan_term_years) passes through unchanged.
 */

/** Output shape preserved from compass's pre-consolidation tool. */
export interface CompassMortgageResult {
  home_price: number;
  down_payment: number;
  loan_amount: number;
  ltv: number;
  monthly_principal_interest: number;
  monthly_property_tax: number;
  monthly_insurance: number;
  monthly_hoa: number;
  monthly_pmi: number;
  monthly_total_piti: number;
  total_interest_over_term: number;
  loan_term_years: number;
}

/**
 * Map realty-core's canonical `MortgageBreakdown` onto compass's
 * historical output shape. Pure / behavior-preserving.
 */
export function toCompassMortgage(b: MortgageBreakdown): CompassMortgageResult {
  return {
    home_price: b.home_price,
    down_payment: b.down_payment,
    loan_amount: b.loan_amount,
    // compass reports LTV as a 0..1 ratio; realty-core as a 0..100 percent.
    ltv: b.ltv_percent / 100,
    monthly_principal_interest: b.monthly_principal_interest,
    monthly_property_tax: b.monthly_property_tax,
    monthly_insurance: b.monthly_insurance,
    monthly_hoa: b.monthly_hoa,
    monthly_pmi: b.monthly_pmi,
    monthly_total_piti: b.monthly_total,
    total_interest_over_term: b.total_interest_paid,
    loan_term_years: b.loan_term_years,
  };
}

export function registerMortgageTools(server: McpServer): void {
  server.registerTool(
    'compass_calculate_mortgage',
    {
      title: 'Calculate mortgage PITI',
      description:
        'Local-only mortgage payment calculator. Returns a full PITI breakdown (principal + interest, property tax, insurance, HOA, PMI) and total interest over the life of the loan. No network call. Provide either `down_payment` OR `down_payment_percent`; defaults to 20%. Property tax can be given as `property_tax_annual` or `property_tax_rate` (% of home price). PMI applies automatically when LTV > 80% and `pmi_rate` is provided.',
      annotations: {
        title: 'Calculate mortgage PITI',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        home_price: z.number().positive(),
        interest_rate: z.number().nonnegative().describe('Annual %, e.g. 6.5'),
        down_payment: z.number().nonnegative().optional(),
        down_payment_percent: z.number().min(0).max(100).optional(),
        loan_term_years: z.number().int().positive().optional().describe('Default 30'),
        property_tax_annual: z.number().nonnegative().optional(),
        property_tax_rate: z
          .number()
          .nonnegative()
          .optional()
          .describe('Annual % of home price'),
        insurance_annual: z.number().nonnegative().optional(),
        hoa_monthly: z.number().nonnegative().optional(),
        pmi_rate: z
          .number()
          .nonnegative()
          .optional()
          .describe('Annual %, applied when LTV > 80%'),
      },
    },
    async (i) =>
      textResult(toCompassMortgage(calculateMortgage(i as MortgageInput)))
  );
}
