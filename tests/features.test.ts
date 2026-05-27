import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_COMMUNITIES,
  extractFeatures,
  loadCommunities,
} from '../src/features.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('extractFeatures', () => {
  const baseCommunities = DEFAULT_COMMUNITIES;

  it('returns all-null/false defaults when description is undefined', () => {
    const out = extractFeatures(undefined, baseCommunities);
    expect(out).toEqual({
      lake_front: false,
      hot_tub: false,
      basement: null,
      furnished: null,
      dock: null,
      community: null,
    });
  });

  it('returns defaults when description is the empty string', () => {
    const out = extractFeatures('', baseCommunities);
    expect(out.lake_front).toBe(false);
    expect(out.basement).toBeNull();
  });

  describe('lake_front', () => {
    it('matches lakefront (one word)', () => {
      expect(extractFeatures('Lakefront paradise', baseCommunities).lake_front).toBe(true);
    });
    it('matches lake front (two words)', () => {
      expect(extractFeatures('Has lake front views', baseCommunities).lake_front).toBe(true);
    });
    it('matches waterfront', () => {
      expect(extractFeatures('Waterfront cottage', baseCommunities).lake_front).toBe(true);
    });
    it('is case-insensitive', () => {
      expect(extractFeatures('LAKEFRONT', baseCommunities).lake_front).toBe(true);
    });
    it('does not match lakeside or oceanfront', () => {
      expect(extractFeatures('lakeside dock', baseCommunities).lake_front).toBe(false);
      expect(extractFeatures('oceanfront property', baseCommunities).lake_front).toBe(false);
    });
  });

  describe('hot_tub', () => {
    it('matches hot tub (with space)', () => {
      expect(extractFeatures('Includes a hot tub', baseCommunities).hot_tub).toBe(true);
    });
    it('does not match hottub or jacuzzi', () => {
      expect(extractFeatures('Has a hottub', baseCommunities).hot_tub).toBe(false);
      expect(extractFeatures('jacuzzi on deck', baseCommunities).hot_tub).toBe(false);
    });
  });

  describe('basement', () => {
    it('returns "unfinished" — checked BEFORE "finished" (substring trap)', () => {
      // REGRESSION PIN: "finished basement" substring-matches inside
      // "unfinished basement". The detector must check the longer
      // phrase first.
      const out = extractFeatures('Has an unfinished basement', baseCommunities);
      expect(out.basement).toBe('unfinished');
    });
    it('returns "finished" for "finished basement"', () => {
      expect(extractFeatures('Finished basement', baseCommunities).basement).toBe(
        'finished'
      );
    });
    it('returns "partial" for "partial basement"', () => {
      expect(extractFeatures('Partial basement', baseCommunities).basement).toBe(
        'partial'
      );
    });
    it('returns "unknown" when basement is mentioned without a qualifier', () => {
      expect(extractFeatures('Basement included', baseCommunities).basement).toBe(
        'unknown'
      );
    });
    it('returns null when basement is not mentioned', () => {
      expect(extractFeatures('Three-car garage', baseCommunities).basement).toBeNull();
    });
  });

  describe('furnished', () => {
    it('returns "fully" for "fully furnished"', () => {
      expect(extractFeatures('Sold fully furnished', baseCommunities).furnished).toBe(
        'fully'
      );
    });
    it('returns "fully" for "turnkey"', () => {
      expect(extractFeatures('Turnkey vacation home', baseCommunities).furnished).toBe(
        'fully'
      );
    });
    it('returns "negotiable" for "furnishings negotiable"', () => {
      expect(
        extractFeatures('Furnishings negotiable', baseCommunities).furnished
      ).toBe('negotiable');
    });
    it('returns "partial" for "with exceptions"', () => {
      expect(
        extractFeatures('Furnished with exceptions', baseCommunities).furnished
      ).toBe('partial');
    });
    it('returns null when no furnished mention', () => {
      expect(extractFeatures('Beautiful home', baseCommunities).furnished).toBeNull();
    });
  });

  describe('dock', () => {
    it('returns "private" for "private dock"', () => {
      expect(extractFeatures('Private dock', baseCommunities).dock).toBe('private');
    });
    it('returns "community" for "community dock"', () => {
      expect(extractFeatures('Community dock access', baseCommunities).dock).toBe(
        'community'
      );
    });
    it('returns "boat_slip" for "boat slip"', () => {
      expect(extractFeatures('Includes boat slip', baseCommunities).dock).toBe(
        'boat_slip'
      );
    });
    it('returns "marina" as the most general dock signal', () => {
      expect(extractFeatures('Walk to marina', baseCommunities).dock).toBe('marina');
    });
    it('prefers "private" over the more general "marina"', () => {
      expect(
        extractFeatures('Private dock at the marina', baseCommunities).dock
      ).toBe('private');
    });
  });

  describe('community', () => {
    it('matches a community from the default vocabulary (case-insensitive)', () => {
      expect(
        extractFeatures('Located in Rumbling Bald.', baseCommunities).community
      ).toBe('Rumbling Bald');
      expect(
        extractFeatures('rumbling bald property', baseCommunities).community
      ).toBe('Rumbling Bald');
    });
    it('picks the earliest mention when multiple are present', () => {
      const text = 'Riverbend at Lake Lure adjoins Rumbling Bald.';
      expect(extractFeatures(text, baseCommunities).community).toBe(
        'Riverbend at Lake Lure'
      );
    });
    it('returns null when no community matches', () => {
      expect(extractFeatures('Suburban Charlotte', baseCommunities).community).toBeNull();
    });
    it('tolerates trailing punctuation', () => {
      expect(
        extractFeatures('Set in The Cliffs.', baseCommunities).community
      ).toBe('The Cliffs');
    });
  });
});

describe('loadCommunities', () => {
  const tmpRoot = join(tmpdir(), `compass-communities-${process.pid}`);
  beforeEach(() => {
    mkdirSync(tmpRoot, { recursive: true });
    delete process.env.COMPASS_COMMUNITIES_FILE;
  });
  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    delete process.env.COMPASS_COMMUNITIES_FILE;
  });

  it('returns DEFAULT_COMMUNITIES when no env var is set', () => {
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
  });

  it('reads a JSON array from the env-var path', () => {
    const path = join(tmpRoot, 'communities.json');
    writeFileSync(path, JSON.stringify(['Alpha Estates', 'Bravo Heights']));
    process.env.COMPASS_COMMUNITIES_FILE = path;
    expect(loadCommunities()).toEqual(['Alpha Estates', 'Bravo Heights']);
  });

  it('falls back to defaults when the file is missing', () => {
    process.env.COMPASS_COMMUNITIES_FILE = join(tmpRoot, 'does-not-exist.json');
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
  });

  it('falls back to defaults when the file is not a string array', () => {
    const path = join(tmpRoot, 'bad.json');
    writeFileSync(path, JSON.stringify({ not: 'an array' }));
    process.env.COMPASS_COMMUNITIES_FILE = path;
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
  });
});
