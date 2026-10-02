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

import { createCachedJsonArrayLoader } from '@chrischall/mcp-utils';
import { DEFAULT_COMMUNITIES as CORE_DEFAULT_COMMUNITIES } from '@chrischall/realty-core';

export { extractFeatures } from '@chrischall/realty-core';
export type { ExtractedFeatures } from '@chrischall/realty-core';

/**
 * Default community vocabulary for the Lake Lure / mountain-NC market —
 * realty-core's shared, frozen `DEFAULT_COMMUNITIES` (fleet-audit#1175),
 * copied because the loader's `defaults` takes a mutable `string[]`.
 * Compass surfaces these names verbatim in listing prose; recognizing
 * them lifts a manual lookup step out of every caller. Override via
 * `COMPASS_COMMUNITIES_FILE` (JSON string array) for other markets.
 */
export const DEFAULT_COMMUNITIES: string[] = [...CORE_DEFAULT_COMMUNITIES];

/**
 * Resolve the active community vocabulary. Reads `COMPASS_COMMUNITIES_FILE`
 * (expects a JSON string array). Falls back to `DEFAULT_COMMUNITIES` when
 * unset, the file is missing, or the JSON is malformed (one stderr warning
 * so misconfiguration is visible). Cached per process keyed by the env-var
 * value — including the negative case, so a misconfigured path doesn't
 * re-hit the filesystem on every `format()` call.
 *
 * The shared `createCachedJsonArrayLoader` from `@chrischall/mcp-utils`
 * (fleet-audit#993) — compass was the last cohort repo with its own copy.
 */
export const loadCommunities: () => string[] = createCachedJsonArrayLoader({
  envVar: 'COMPASS_COMMUNITIES_FILE',
  defaults: DEFAULT_COMMUNITIES,
  label: 'compass-mcp',
});
