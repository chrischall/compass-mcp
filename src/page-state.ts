/**
 * Extract Compass's two inline-script state globals from a rendered HTML page.
 *
 * Compass is a fully SSR React app with no canonical `__NEXT_DATA__`
 * blob. Instead, the bootstrap script writes:
 *
 *   - `global.uc = {...}` — the "user context" / app-wide bootstrap
 *     object. On search-results pages this carries
 *     `sharedReactAppProps.initialResults` with the listings array.
 *
 *   - `global.__INITIAL_DATA__ = {props: {...}}` — used by the
 *     homedetails / property-page route. The listing record lives at
 *     `props.listingRelation.listing`.
 *
 * Both are JSON values written into an inline script via JS-literal
 * syntax (i.e. `global.uc = {"key":"value",...};`). We extract them
 * by anchoring on the assignment prefix and walking a balanced brace.
 *
 * Verified live 2026-05-24 against:
 *   - https://www.compass.com/homes-for-sale/new-york-ny/
 *   - https://www.compass.com/homedetails/.../<listingIdSHA>_lid/
 */

// The balanced-brace walker and global-assignment lifter were generalized
// out of this file into `@fetchproxy/server` (it now serves the whole
// SSR-scraping realty cohort). We consume the published versions rather
// than maintain local copies. fetchproxy's `extractGlobalAssign` is a
// strict superset of the old local one — it additionally matches
// `var|let|const` declarations, adds an identifier-boundary guard (so a
// search for `uc` won't match `myuc`), and escapes all regex
// metacharacters — and is behavior-identical for Compass's three names
// (`uc`, `__INITIAL_DATA__`, `__AGENT_PROFILE__`).
import { extractGlobalAssign } from '@fetchproxy/server';

// Re-export so existing importers (and tests) can keep pulling these
// primitives from `page-state.ts` with zero churn.
export { extractBalancedObject, extractGlobalAssign } from '@fetchproxy/server';

/**
 * Extract the `uc` global from a Compass page. This is the bootstrap
 * object set on every page (search, homedetails, account, etc.); the
 * useful payload on search pages lives at
 * `uc.sharedReactAppProps.initialResults`.
 */
export function extractUc(html: string): Record<string, unknown> | null {
  return extractGlobalAssign(html, 'uc');
}

/**
 * Extract `__INITIAL_DATA__` from a Compass page. Used by the homedetails
 * route. The shape is `{props: {…, listingRelation: {listing: …}}}`.
 */
export function extractInitialData(html: string): Record<string, unknown> | null {
  return extractGlobalAssign(html, '__INITIAL_DATA__');
}

/**
 * Extract `__AGENT_PROFILE__` from a Compass agent profile page
 * (`/agents/<slug>/`). Unlike the search / homedetails routes (which use
 * `uc` and `__INITIAL_DATA__`), agent profile pages embed their SSR state
 * as a `window.__AGENT_PROFILE__ = {…}` blob (~1.4MB) with no
 * `__NEXT_DATA__`. The useful payload lives at
 * `data.agentProfileProps.activeListingsProps.initialSales` (active
 * listings) and `data.agentProfileProps.closedDealsProps.initialSales`
 * (closed deals). (Issue #52.)
 */
export function extractAgentProfile(
  html: string
): Record<string, unknown> | null {
  return extractGlobalAssign(html, '__AGENT_PROFILE__');
}
