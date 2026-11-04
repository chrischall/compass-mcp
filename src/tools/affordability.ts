import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  calculateAffordability,
  registerAffordabilityTool,
  type AffordabilityInput,
  type AffordabilityResult,
} from '@chrischall/realty-core';
import { minifiedResult } from '../mcp.js';
import { homeMeta, withMintMeta } from './hints.js';

/**
 * Local-only affordability calculator. Solves for max home price under
 * the standard 28/36 DTI rule. The math is the cohort-canonical
 * `calculateAffordability` (realty-core) — the same helper zillow /
 * redfin / homes / onehome share.
 *
 * realty-core's `AffordabilityResult` shape is byte-identical to
 * compass's historical `computeAffordability` output (same field names,
 * same rounding), so the consolidation is a straight delegation — no
 * adapter needed. `computeAffordability` stays exported as a thin alias
 * so existing call sites + unit tests keep their import.
 */

export type { AffordabilityInput, AffordabilityResult };

/**
 * Thin alias over realty-core's `calculateAffordability`. Preserved as a
 * named export because the tool's tests refer to `computeAffordability`.
 */
export function computeAffordability(
  input: AffordabilityInput
): AffordabilityResult {
  return calculateAffordability(input);
}

export function registerAffordabilityTools(server: McpServer): void {
  // realty-core's shared registrar (fleet-audit#1090): schema (with the
  // MAX_LOAN_TERM_YEARS cap), description and math.
  // It takes no `_meta`; the view adds the group hint.
  registerAffordabilityTool(
    withMintMeta(server, {
      compass_calculate_affordability: homeMeta('lookup', ['afford', 'how much house', 'budget']),
    }),
    { z, prefix: 'compass', toResult: minifiedResult }
  );
}
