import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  registerMortgageTool,
  toLeanMortgage,
  type LeanMortgageResult,
  type MortgageBreakdown,
} from '@chrischall/realty-core';
import { minifiedResult } from '../mcp.js';

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

/**
 * Output shape preserved from compass's pre-consolidation tool — realty-core's
 * `LeanMortgageResult` (`ltv` as a 0..1 ratio, `monthly_total_piti`,
 * `total_interest_over_term`).
 */
export type CompassMortgageResult = LeanMortgageResult;

/**
 * Project the canonical breakdown onto compass's lean shape. Now
 * realty-core's `toLeanMortgage` — the adapter homes / compass / onehome
 * each hand-wrote (fleet-audit#1090).
 */
export const toCompassMortgage: (b: MortgageBreakdown) => CompassMortgageResult =
  toLeanMortgage;

/**
 * `compass_calculate_mortgage` — realty-core's shared registrar in the lean
 * shape: schema (with `loan_term_years` capped at MAX_LOAN_TERM_YEARS),
 * description and math all live there.
 */
export function registerMortgageTools(server: McpServer): void {
  registerMortgageTool(server, {
    z,
    prefix: 'compass',
    shape: 'lean',
    toResult: minifiedResult,
  });
}
