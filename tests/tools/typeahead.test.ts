import { describe, it, expect } from 'vitest';
import {
  OMNISUGGEST_AUTOCOMPLETE_PATH,
  buildAutocompleteBody,
  extractAddressCandidates,
  type OmnisuggestResponse,
} from '../../src/tools/typeahead.js';

/**
 * Fixtures captured live 2026-05-28 from
 *   POST https://www.compass.com/api/v3/omnisuggest/autocomplete
 * with body `{ "q": "<address>", "sources": [0] }` against a signed-in
 * Compass session (issue #78 / #79). The `id` field is the listing
 * `listingIdSHA` — it matches the `_lid/` URL segment on the public
 * homedetails page.
 */

// 158 Raven Blvd, Lake Lure NC — single exact candidate.
const RAVEN_RESPONSE: OmnisuggestResponse = {
  categories: [
    {
      name: 1,
      label: 'Addresses',
      items: [
        {
          text: '158 Raven Blvd',
          subText: 'Lake Lure, NC',
          redirectUrl: '/listing/2029026490125049409/view',
          source: 0,
          id: '2029026490125049409',
          ucGeoId: 'charlotte',
          info: {},
        },
      ],
    },
  ],
  success: true,
  rankerVersion: 'v5.0',
};

// 155 Quail Cove Blvd Unit 1601, Lake Lure NC — multi-unit; only the
// 1601 candidate carries the matching unit token.
const QUAIL_RESPONSE: OmnisuggestResponse = {
  categories: [
    {
      name: 1,
      label: 'Addresses',
      items: [
        {
          text: '155 Quail Cove Blvd, Unit 1602',
          subText: 'Lake Lure, NC',
          redirectUrl: '/listing/1745067614490786889/view',
          source: 0,
          id: '1745067614490786889',
          ucGeoId: 'charlotte',
        },
        {
          text: '155 Quail Cove Blvd, Unit 1601',
          subText: 'Lake Lure, NC',
          redirectUrl: '/listing/2079951245069150641/view',
          source: 0,
          id: '2079951245069150641',
          ucGeoId: 'charlotte',
        },
      ],
    },
  ],
  success: true,
};

describe('OMNISUGGEST_AUTOCOMPLETE_PATH', () => {
  it('targets the v3 omnisuggest autocomplete endpoint', () => {
    expect(OMNISUGGEST_AUTOCOMPLETE_PATH).toBe(
      '/api/v3/omnisuggest/autocomplete'
    );
  });
});

describe('buildAutocompleteBody', () => {
  it('carries the joined address as `q` and restricts to the Addresses source', () => {
    const body = buildAutocompleteBody({
      address: '158 Raven Blvd',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    expect(body.q).toBe('158 Raven Blvd Lake Lure NC 28746');
    // source 0 is the "Addresses" omnisuggest source — narrows the
    // result set to street addresses (verified live).
    expect(body.sources).toEqual([0]);
  });
});

describe('extractAddressCandidates', () => {
  it('pulls the Addresses category (name === 1) items', () => {
    const candidates = extractAddressCandidates(RAVEN_RESPONSE);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe('2029026490125049409');
    expect(candidates[0].text).toBe('158 Raven Blvd');
    expect(candidates[0].subText).toBe('Lake Lure, NC');
  });

  it('returns every Addresses item for multi-unit responses', () => {
    const candidates = extractAddressCandidates(QUAIL_RESPONSE);
    expect(candidates.map((c) => c.id)).toEqual([
      '1745067614490786889',
      '2079951245069150641',
    ]);
  });

  it('returns [] when the response has no Addresses category', () => {
    expect(
      extractAddressCandidates({
        categories: [{ name: 2, label: 'Cities', items: [] }],
      })
    ).toEqual([]);
  });

  it('returns [] for an empty / malformed response', () => {
    expect(extractAddressCandidates({})).toEqual([]);
    expect(extractAddressCandidates({ categories: [] })).toEqual([]);
  });

  it('skips candidate items that carry no id', () => {
    const candidates = extractAddressCandidates({
      categories: [
        {
          name: 1,
          label: 'Addresses',
          items: [
            { text: 'No id here', subText: 'X, NY' } as never,
            {
              text: '1 Real St',
              subText: 'X, NY',
              id: 'real-id',
              source: 0,
              redirectUrl: '/listing/real-id/view',
            },
          ],
        },
      ],
    });
    expect(candidates.map((c) => c.id)).toEqual(['real-id']);
  });
});
