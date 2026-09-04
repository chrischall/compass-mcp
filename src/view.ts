import { minifiedResult, resolveView, stripMediaUrls, viewParam, type View } from '@chrischall/mcp-utils';

/**
 * The rungs this server honours (`@chrischall/mcp-utils`' `view` vocabulary;
 * `chrischall/workflows` `docs/fleet-conventions.md`, "Response shape").
 *
 * **What compact does here, and what it deliberately does NOT do.**
 *
 * The read tools in this server hand back Compass's payload close to
 * verbatim, and the repo holds no verified record of what those payloads
 * contain — no captured fixture, no documented field list. So nothing here can
 * honestly say which of Compass's fields matter and which are noise.
 *
 * Compact therefore does the one projection that needs no such knowledge: it
 * strips image and avatar URLs. That is SUBTRACTIVE, so it cannot lose a field
 * nobody knew about — the failure an invented field list would risk, where a
 * record comes back with holes in it and reads like a verified answer.
 *
 * When a real payload can be captured, a field projection belongs here beside
 * this one and will save considerably more. Until then this is the honest
 * ceiling, and this docblock says so rather than implying a shape was checked.
 */
export const CP_VIEWS = ['compact', 'full'] as const;

const NOTE =
  'compact strips image/avatar URLs from the response; "full" returns Compass\'s payload untouched. ' +
  'No field projection: this server has no verified record of which Compass fields matter, and inventing ' +
  'one would risk dropping a field a caller needs.';

/** The `view` parameter every read tool in this server takes. */
export const viewArg = (): ReturnType<typeof viewParam> => viewParam(CP_VIEWS, { note: NOTE });

/**
 * `primary_photo_url` / `primary_thumbnail_url` are DROPPED by name.
 *
 * These are the search-card media fields (`formatHome` in `tools/search.ts`),
 * and they are a PASS-THROUGH, not a derivation: the values are
 * `listing.media[0].originalUrl` and `.thumbnailUrl` verbatim off Compass's own
 * payload, renamed and nothing more. Contrast `redfin-mcp`, which CONSTRUCTS
 * its `image_url` from `mlsId` + `dataSourceId` with knowledge of Redfin's URL
 * scheme and therefore keeps it: a field this repo built is a grounded choice,
 * a field this repo merely copied is the decoration `stripMediaUrls` exists to
 * remove. So the subtractive rule is the right answer here, and there is
 * nothing to `keep`.
 *
 * They are listed in `drop` rather than left to the library's own rules because
 * neither of those rules reliably catches them:
 *
 *  - `MEDIA_KEY` is anchored at the START of the key (`^photo…`, `^thumbnail…`)
 *    — deliberately, so that a `hasThumbnail: false` FACT survives. Our keys are
 *    prefixed with `primary_`, so it matches neither.
 *  - `MEDIA_URL` matches only a URL whose PATH ends in an image extension. Some
 *    Compass CDN URLs do end in `.jpg`; a signed or extension-less one does not.
 *
 * The two together mean compact would have stripped these fields on some
 * listings and kept them on others, in the same response — a projection whose
 * effect depends on the shape of a URL is not a projection a caller can reason
 * about. Naming the keys makes it deterministic. This is exactly the local fix
 * `drop` was added for: a repo should not need a library release to strip its
 * own noise.
 *
 * `compass_get_property_photos` takes no `view` at all and must never be given
 * one — its PRODUCT is the gallery, and stripping there empties the response
 * instead of shrinking it.
 */
const DROP = ['primary_photo_url', 'primary_thumbnail_url'] as const;

/**
 * Answer in the requested rung.
 *
 * Only ever called from a READ tool. A write's response is a receipt — an id,
 * a status — with nothing to strip and everything to keep.
 */
export function viewResponse(view: string | undefined, data: unknown): ReturnType<typeof minifiedResult> {
  const rung: View = resolveView(view, CP_VIEWS);
  return minifiedResult(rung === 'compact' ? stripMediaUrls(data, { drop: DROP }) : data);
}
