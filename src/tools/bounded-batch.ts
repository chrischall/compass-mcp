/**
 * Shared overall-deadline plumbing for the three bridge fan-out tools
 * (`compass_bulk_get`, `compass_compare_properties`,
 * `compass_resolve_addresses`) — fleet-audit#927.
 *
 * Each of those tools runs its rows through `runBoundedBatch` from
 * `@chrischall/mcp-utils` with {@link OVERALL_DEADLINE_MS}: when the
 * deadline fires, every row that has not settled is backfilled with a
 * retryable `status: 'pending'` row and the call returns the rows that did
 * complete, instead of running past the MCP client's ~60s request deadline
 * (`-32001`) and losing all of them. Same contract as the redfin / zillow /
 * homes siblings.
 *
 * The rest of the plumbing — the row envelope, `pending` message and the
 * abandoned-row client guard (formerly `guardClient` / `pendingMessage` /
 * `DeadlineAbandonedError` here) — is realty-core's `runRowBatch` /
 * `pendingRowMessage` / `guardMethods` / `RowAbandonedError`
 * (fleet-audit#1091), tested there.
 */

/**
 * Overall hard deadline (ms) for one bulk tool call — comfortably under
 * the MCP client's ~60s request deadline, matching the cohort's 45s value
 * (zillow #98, homes #54, redfin #220/#221).
 */
export const OVERALL_DEADLINE_MS = 45_000;

/**
 * Tuning knobs. Production uses the defaults; tests inject a tiny
 * `overallDeadlineMs` so the suite doesn't wait on wall-clock.
 */
export interface BulkTuning {
  overallDeadlineMs?: number;
}
