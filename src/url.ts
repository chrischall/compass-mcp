/**
 * Small URL helpers shared across tools.
 *
 * Compass's pages are served from a fixed `https://www.compass.com`
 * origin, and the FetchproxyTransport prepends that for us — tools
 * work in terms of paths, not URLs. When a tool accepts a `url` arg
 * from the user, we need to reduce it down to a path before handing
 * it off.
 *
 * `urlToPath` and `locationToSlug` are cohort-hoisted helpers — their
 * compass bodies were byte-identical to the canonical versions, so we
 * re-export them from `@chrischall/realty-core` (realty-mcp#1) rather
 * than carry local copies. `extractPidFromUrl` stays local: the `_pid/`
 * id scheme is compass-specific.
 */

// Re-exported from the cohort helper package — bodies were byte-identical.
export { urlToPath, locationToSlug } from '@chrischall/realty-core';

/**
 * Extract the opaque `pid` from a Compass `_pid/` URL.
 *
 * Compass exposes two URL forms for a listing:
 *
 *   - `/<prefix>/<slug>/<pid>_pid/`  — opaque short ID, **stable** across
 *     re-listings. Preferred for trackers, bookmarks, sheet rows.
 *   - `/homedetails/<slug>/<sha>_lid/` — content-addressed sha,
 *     **changes** when a property is delisted and relisted. Useful
 *     for fetching the current listing record, but does not survive
 *     relistings.
 *
 * The `listing.navigationPageLink` field carries the `_pid/` form when
 * one is available; pulling the `pid` out of it lets the agent
 * reconstruct the stable URL on demand.
 *
 * Returns undefined for any non-`_pid/` shape (including `_lid/`).
 */
export function extractPidFromUrl(
  link: string | undefined
): string | undefined {
  if (!link) return undefined;
  const m = /\/([A-Za-z0-9]+)_pid\/?$/.exec(link);
  return m ? m[1] : undefined;
}
