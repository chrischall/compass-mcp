/**
 * Small helpers for shaping tool responses that the MCP SDK expects.
 *
 * `textResult` was byte-identical across the whole MCP fleet, so it now
 * lives in `@chrischall/mcp-utils` (the shared scaffolding package — the
 * canonical home for this and the test harness). We re-export it here so
 * every `compass_*` tool keeps importing it from the stable `../mcp.js`
 * surface: no churn at the call sites, no local copy to drift.
 */
export { textResult } from '@chrischall/mcp-utils';
