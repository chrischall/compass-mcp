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

/**
 * Normalize an agent reference to its profile slug. Accepts (issue #52):
 *
 *   - a bare slug:            `paige-mcguirk`
 *   - an `/agents/<slug>/` path (leading slash optional, trailing optional)
 *   - a full profile URL:     `https://www.compass.com/agents/paige-mcguirk/`
 *
 * Query strings and fragments are ignored. Slugs are lowercased and must
 * match `^[a-z0-9-]+$` (the shape of a real Compass agent slug). Throws on
 * empty input, on a compass URL/path that isn't an `/agents/` profile
 * reference, and on a slug carrying illegal characters (e.g. `..`,
 * `foo bar`) — so a caller who fat-fingers a reference gets a clear error
 * rather than a silently-wrong / malformed fetch.
 */
const AGENT_SLUG_RE = /^[a-z0-9-]+$/;

function validateAgentSlug(slug: string, original: string): string {
  const normalized = slug.trim().toLowerCase();
  if (!AGENT_SLUG_RE.test(normalized)) {
    throw new Error(
      `compass agent tool: "${original}" is not a valid Compass agent slug. ` +
        'Expected a slug matching ^[a-z0-9-]+$ (e.g. "paige-mcguirk").'
    );
  }
  return normalized;
}

export function extractAgentSlug(slugOrUrl: string): string {
  const trimmed = (slugOrUrl ?? '').trim();
  if (!trimmed) {
    throw new Error(
      'compass agent tool: an agent `slug` or `profile_url` is required (e.g. "paige-mcguirk" or "https://www.compass.com/agents/paige-mcguirk/").'
    );
  }
  // URL or path form: pull the segment after `/agents/`.
  if (/[/]/.test(trimmed) || /^https?:/i.test(trimmed)) {
    const m = /\/agents\/([^/?#]+)/.exec(trimmed);
    if (!m) {
      throw new Error(
        `compass agent tool: "${slugOrUrl}" is not a Compass agent profile URL. ` +
          'Expected a bare slug or a /agents/<slug>/ URL.'
      );
    }
    // decodeURIComponent throws a URIError on a malformed percent-encoding
    // (e.g. `%ZZ`); fall back to the raw segment so validateAgentSlug
    // surfaces the clear slug error rather than the raw URIError.
    let decoded: string;
    try {
      decoded = decodeURIComponent(m[1]);
    } catch {
      decoded = m[1];
    }
    return validateAgentSlug(decoded, slugOrUrl);
  }
  // Bare slug.
  return validateAgentSlug(trimmed, slugOrUrl);
}

/**
 * Build the `/agents/<slug>/` path the FetchproxyTransport fetches from a
 * slug or any accepted agent reference (delegates to `extractAgentSlug`).
 * (Issue #52.)
 */
export function agentProfilePath(slugOrUrl: string): string {
  return `/agents/${extractAgentSlug(slugOrUrl)}/`;
}
