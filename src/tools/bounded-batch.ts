import type { CompassClient } from '../client.js';

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

/** Human-readable message carried on every `pending` row. */
export function pendingMessage(toolName: string): string {
  return (
    `${toolName} overall deadline reached before this row settled — the ` +
    'lookup is still pending (likely a slow or hung browser tab), NOT a ' +
    'missing listing. Re-run just the pending rows.'
  );
}

/** Thrown in place of a bridge request once the batch has been abandoned. */
export class DeadlineAbandonedError extends Error {
  constructor() {
    super('overall deadline reached; request not sent');
    this.name = 'DeadlineAbandonedError';
  }
}

/**
 * Wrap `client` so its bridge-dialling methods refuse to start once
 * `signal` is aborted.
 *
 * `runBoundedBatch` aborts the signal when the deadline fires, but its
 * runners keep dequeuing queued items (mcp-utils <= 2.6), and an in-flight
 * row can still walk on to its next request (the address resolver makes up
 * to three per row). Guarding at the client covers both: after the call has
 * returned `pending` rows, nothing else goes out through the user's
 * browser tab (the redfin fleet-audit finding on the same pattern).
 */
export function guardClient(
  client: CompassClient,
  signal: AbortSignal | undefined
): CompassClient {
  if (!signal) return client;
  const guarded = new Set<PropertyKey>(['fetchHtml', 'fetchJson']);
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (!guarded.has(prop)) return fn.bind(target);
      return (...args: unknown[]) => {
        if (signal.aborted) {
          return Promise.reject(new DeadlineAbandonedError());
        }
        return fn.apply(target, args);
      };
    },
  });
}
