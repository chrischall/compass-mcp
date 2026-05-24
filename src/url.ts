/**
 * Small URL helpers shared across tools.
 *
 * Compass's pages are served from a fixed `https://www.compass.com`
 * origin, and the FetchproxyTransport prepends that for us — tools
 * work in terms of paths, not URLs. When a tool accepts a `url` arg
 * from the user, we need to reduce it down to a path before handing
 * it off.
 */

/**
 * Reduce a Compass URL (or path) to its path+search portion.
 *
 * Accepts an absolute URL (any host — we only keep the path), a path
 * starting with `/`, or a bare segment which we coerce to a leading-slash
 * path. Returns the path+search ready to hand to `CompassClient.fetchHtml`.
 */
export function urlToPath(input: string): string {
  try {
    const u = new URL(input);
    return `${u.pathname}${u.search}`;
  } catch {
    return input.startsWith('/') ? input : `/${input}`;
  }
}

/**
 * Slugify a free-text location into Compass's search URL format.
 *
 *   "Brooklyn, NY"  → "brooklyn-ny"
 *   "New York, NY"  → "new-york-ny"
 *   "94110"         → "94110"
 *   "Park Slope"    → "park-slope"
 *
 * Compass's `/homes-for-sale/<slug>/` route accepts these as
 * city/neighborhood/ZIP segments. Diacritics are stripped, spaces and
 * commas collapse to `-`, and trailing/leading separators are trimmed.
 */
export function locationToSlug(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
