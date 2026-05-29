/**
 * Community-vocabulary loading for Compass listing feature extraction.
 *
 * The keyword extractor itself (`extractFeatures` + `ExtractedFeatures`)
 * now lives in `@chrischall/realty-core` — the canonical helper that
 * reconciles the five cohort MCPs' byte-for-byte `src/features.ts`
 * implementations. We re-export it here so existing consumers keep a
 * stable `../features.js` import surface.
 *
 * Compass listings ship 1.5–3 KB of marketing copy in `description`.
 * Real-world callers (see issue #35) immediately keyword-parse it for
 * the same handful of features — lake/waterfront, hot tub, basement,
 * furnished, dock, community — and discard the prose. The canonical
 * extractor lifts that work so callers can drop the raw description
 * (paired with the `include_description=false` default on
 * `compass_get_property` / `compass_compare_properties`).
 *
 * `loadCommunities` STAYS local: it does filesystem I/O (reads a JSON
 * file named by `COMPASS_COMMUNITIES_FILE`), which would break
 * realty-core's no-I/O invariant. It resolves the `communities`
 * vocabulary that `extractFeatures` consumes.
 *
 * Note the canonical basement detector is STRICTER than compass's old
 * inline copy: it uses a `BASEMENT_CONNECTOR` conjunct class rather than
 * a loose `[^.!?]{0,30}?` window, so prose like "basement with finished
 * oak shelving" resolves to `'unknown'` (the shelving is finished, not
 * the basement) instead of false-positiving to `'finished'`.
 */

import { existsSync, readFileSync } from 'node:fs';

export { extractFeatures } from '@chrischall/realty-core';
export type { ExtractedFeatures } from '@chrischall/realty-core';

/**
 * Default community vocabulary for the Lake Lure / mountain-NC market.
 * Compass surfaces these names verbatim in listing prose; recognizing
 * them lifts a manual lookup step out of every caller. Override via
 * `COMPASS_COMMUNITIES_FILE` (JSON string array) for other markets —
 * see `loadCommunities` for the env-var contract.
 */
export const DEFAULT_COMMUNITIES: string[] = [
  'Rumbling Bald',
  'Riverbend at Lake Lure',
  'The Lodges at Eagles Nest',
  'Hunters Ridge',
  'Beech Mountain Club',
  'The Cliffs',
  'Pinnacle Ridge',
  'Highland Heights',
  'Shelter Rock',
  'Charter Hills',
];

let cachedCommunities: string[] | null = null;
let cachedPath: string | null = null;

/**
 * Resolve the active community vocabulary. Reads `COMPASS_COMMUNITIES_FILE`
 * (expects a JSON string array). Falls back to `DEFAULT_COMMUNITIES` when
 * unset, the file is missing, or the JSON is malformed (with a stderr
 * warning so misconfiguration is visible). Cached per process keyed by
 * the env-var value.
 */
export function loadCommunities(): string[] {
  const path = process.env.COMPASS_COMMUNITIES_FILE?.trim();
  if (!path) {
    cachedCommunities = null;
    cachedPath = null;
    return DEFAULT_COMMUNITIES;
  }
  if (cachedCommunities && cachedPath === path) {
    return cachedCommunities;
  }
  if (!existsSync(path)) {
    console.error(
      `[compass-mcp] COMPASS_COMMUNITIES_FILE="${path}" not found — falling back to DEFAULT_COMMUNITIES.`
    );
    return DEFAULT_COMMUNITIES;
  }
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === 'string')) {
      console.error(
        `[compass-mcp] COMPASS_COMMUNITIES_FILE="${path}" must be a JSON string array — falling back to DEFAULT_COMMUNITIES.`
      );
      return DEFAULT_COMMUNITIES;
    }
    cachedCommunities = parsed;
    cachedPath = path;
    return cachedCommunities;
  } catch (err) {
    console.error(
      `[compass-mcp] failed to load COMPASS_COMMUNITIES_FILE="${path}": ${
        err instanceof Error ? err.message : String(err)
      } — falling back to DEFAULT_COMMUNITIES.`
    );
    return DEFAULT_COMMUNITIES;
  }
}
