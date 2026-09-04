import { describe, it, expect } from 'vitest';
import { CP_VIEWS, viewArg, viewResponse } from '../src/view.js';

/**
 * `src/view.ts` is three lines of glue over `@chrischall/mcp-utils`, which is
 * exactly why it needs its own tests: every read tool in this server routes its
 * response through it, so a wrong `keep`/`drop` list or a mis-resolved default
 * is a fleet-wide silent data loss with nothing local to catch it. The library's
 * own suite covers `stripMediaUrls`; what is unverified — and what these tests
 * pin — is the POLICY this repo layers on top.
 */

/** Read a `viewResponse` back as the object a caller would `JSON.parse`. */
function parse<T>(result: ReturnType<typeof viewResponse>): T {
  const block = result.content[0];
  if (block?.type !== 'text') throw new Error('expected a text content block');
  return JSON.parse(block.text) as T;
}

/** The raw text of a `viewResponse`, for assertions about the wire form. */
function text(result: ReturnType<typeof viewResponse>): string {
  const block = result.content[0];
  if (block?.type !== 'text') throw new Error('expected a text content block');
  return block.text;
}

describe('CP_VIEWS', () => {
  it('offers exactly the two rungs, compact first', () => {
    // Order is load-bearing: `resolveView` treats the FIRST rung as the
    // default, which is how "compact by default" is expressed. A reordering
    // here would silently flip every read tool back to full payloads.
    expect(CP_VIEWS).toEqual(['compact', 'full']);
  });
});

describe('viewArg', () => {
  it('is optional, so an existing caller that passes no view still works', () => {
    // The `view` parameter was added to tools that already had callers. If it
    // were required, every one of those calls would start failing schema
    // validation — a breaking change dressed up as a size optimization.
    const arg = viewArg();
    expect(arg.safeParse(undefined).success).toBe(true);
  });

  it('accepts both rungs and rejects a rung this server does not offer', () => {
    const arg = viewArg();
    expect(arg.safeParse('compact').success).toBe(true);
    expect(arg.safeParse('full').success).toBe(true);
    // 'summary' and 'raw' exist elsewhere in the fleet's vocabulary. This
    // server does not implement them, and accepting one would mean silently
    // answering in some other rung than the caller asked for.
    expect(arg.safeParse('summary').success).toBe(false);
  });
});

describe('viewResponse', () => {
  it('defaults to compact when no view is passed', () => {
    // The headline behaviour of the whole change: a caller who has never heard
    // of `view` gets the smaller payload.
    const out = parse<{ avatar?: string; name: string }>(
      viewResponse(undefined, { name: 'Agent', avatar: 'https://cdn/a.png' })
    );
    expect(out).toEqual({ name: 'Agent' });
  });

  it('returns the payload untouched under full', () => {
    // `full` is the escape hatch, and it has to be a true escape hatch: a
    // caller who explicitly asks for the media URLs must get every one of
    // them, or the parameter is decoration.
    const payload = {
      name: 'Agent',
      avatar: 'https://cdn/a.png',
      primary_photo_url: 'https://cdn/p.jpg',
      primary_thumbnail_url: 'https://cdn/t',
    };
    expect(parse<typeof payload>(viewResponse('full', payload))).toEqual(payload);
  });

  it('drops primary_photo_url / primary_thumbnail_url by KEY under compact', () => {
    // The reason these are in `drop` rather than left to the library. The
    // library's key rule is anchored at the start of the key, so `primary_`
    // defeats it; its value rule needs an image extension ending the path, so
    // an extension-less CDN URL defeats that too. Without the explicit drop,
    // compact would strip these on some listings and keep them on others in
    // the same response — a projection whose effect depends on the shape of a
    // URL is one a caller cannot reason about.
    const out = parse<Record<string, unknown>>(
      viewResponse('compact', {
        results: [
          {
            listing_id_sha: '1',
            // No image extension: the value rule cannot see this one.
            primary_photo_url: 'https://cdn.compass.com/i/abc?sig=xyz',
            primary_thumbnail_url: 'https://cdn.compass.com/t/abc?sig=xyz',
          },
          {
            listing_id_sha: '2',
            // Has one: the value rule WOULD have caught this one. Both must
            // behave identically.
            primary_photo_url: 'https://cdn.compass.com/i/def.jpg',
            primary_thumbnail_url: 'https://cdn.compass.com/t/def.jpg',
          },
        ],
      })
    );
    expect(out).toEqual({
      results: [{ listing_id_sha: '1' }, { listing_id_sha: '2' }],
    });
  });

  it('keeps a non-media field whose name merely contains a media noun', () => {
    // The safety property of the anchored key rule, asserted from this side so
    // that widening `drop` later cannot quietly break it. `photo_count` is a
    // FACT about the listing and the caller's cue that the photos tool has
    // more; a caller filtering on it would otherwise see the key vanish and
    // read that as "not reported".
    const out = parse<Record<string, unknown>>(
      viewResponse('compact', { photo_count: 24, has_thumbnail: false })
    );
    expect(out).toEqual({ photo_count: 24, has_thumbnail: false });
  });

  it('preserves a field nobody anticipated', () => {
    // Compact is SUBTRACTIVE by design — it strips known media, it does not
    // project onto a field allowlist. This repo holds no verified record of
    // Compass's payload shape, so an allowlist would hand back records with
    // holes in them that read like a verified answer.
    const out = parse<Record<string, unknown>>(
      viewResponse('compact', { somethingNobodyAnticipated: { deep: [1, 2, 3] } })
    );
    expect(out).toEqual({ somethingNobodyAnticipated: { deep: [1, 2, 3] } });
  });

  it('preserves null, which is a different answer from an absent key', () => {
    // `null` says "reported, and empty"; an absent key says "not reported".
    // Collapsing the two buys a couple of percent and costs the distinction.
    const out = parse<Record<string, unknown>>(
      viewResponse('compact', { price_max: null, sqft: 0, saved: false })
    );
    expect(out).toEqual({ price_max: null, sqft: 0, saved: false });
  });

  it('never mutates the payload it was handed', () => {
    // Tools assemble a payload and hand it straight in; some fleet repos hand
    // in live cache rows. A strip that edited in place would corrupt the
    // caller's own object.
    const payload = { name: 'Agent', avatar: 'https://cdn/a.png' };
    viewResponse('compact', payload);
    expect(payload).toEqual({ name: 'Agent', avatar: 'https://cdn/a.png' });
  });

  it('emits a single line of JSON in both rungs', () => {
    // Minification is not cosmetic: pretty-printing a listing array is pure
    // indentation tokens. Asserted on the serialized text, because it is the
    // wire form and not the parsed object that costs the caller.
    const payload = { results: [{ listing_id_sha: '1' }, { listing_id_sha: '2' }] };
    expect(text(viewResponse('compact', payload))).not.toContain('\n');
    expect(text(viewResponse('full', payload))).not.toContain('\n');
  });

  it('leaves whitespace INSIDE a value byte-identical', () => {
    // The failure mode minification invites. A listing description carries
    // real newlines and blank lines, and they are the author's paragraphing —
    // "minified" must mean "no whitespace BETWEEN tokens", never "whitespace
    // normalized inside strings". A `JSON.stringify(v)` with no indent
    // argument gets this right for free; a hand-rolled minifier would not.
    const description = 'Sun-drenched corner unit.\n\n  Chef\'s kitchen.\n\tParking included.';
    for (const rung of ['compact', 'full'] as const) {
      const out = parse<{ description: string }>(
        viewResponse(rung, { description })
      );
      expect(out.description).toBe(description);
    }
  });
});
