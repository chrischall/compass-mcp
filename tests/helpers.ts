/**
 * In-memory MCP test harness.
 *
 * `createTestHarness` + `parseToolResult` were byte-identical across the
 * fleet's `tests/helpers.ts`, so the canonical versions now live in
 * `@chrischall/mcp-utils/test`. We re-export them here so every
 * `tests/**` file keeps importing from the stable `./helpers.js` surface
 * — no churn, no local copy to drift.
 */
export { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
