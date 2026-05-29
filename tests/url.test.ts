import { describe, it, expect } from 'vitest';
import {
  agentProfilePath,
  extractAgentSlug,
  extractPidFromUrl,
  locationToSlug,
  urlToPath,
} from '../src/url.js';

describe('urlToPath', () => {
  it('preserves a bare leading-slash path', () => {
    expect(urlToPath('/homedetails/foo/bar_lid/')).toBe('/homedetails/foo/bar_lid/');
  });

  it('reduces a full URL to its path + search', () => {
    expect(urlToPath('https://www.compass.com/homedetails/foo/123_lid/?ref=abc')).toBe(
      '/homedetails/foo/123_lid/?ref=abc'
    );
  });

  it('adds a leading slash to bare path-shaped input', () => {
    expect(urlToPath('homedetails/foo/123_lid/')).toBe('/homedetails/foo/123_lid/');
  });
});

describe('extractPidFromUrl', () => {
  it('extracts the pid from a /listing/<slug>/<pid>_pid/ path', () => {
    expect(
      extractPidFromUrl('/listing/126-Sleeping-Bear-Ln-Lake-Lure-NC-28746/WNQQ8_pid/')
    ).toBe('WNQQ8');
  });

  it('extracts the pid from a /homedetails/<slug>/<pid>_pid/ path', () => {
    expect(extractPidFromUrl('/homedetails/foo/203T5X_pid/')).toBe('203T5X');
  });

  it('accepts a full URL', () => {
    expect(
      extractPidFromUrl('https://www.compass.com/listing/foo/WNQQ8_pid/')
    ).toBe('WNQQ8');
  });

  it('returns undefined for a _lid/ form (content-addressed by sha)', () => {
    expect(
      extractPidFromUrl('/homedetails/foo/2109718971930079225_lid/')
    ).toBeUndefined();
  });

  it('returns undefined for undefined/empty input', () => {
    expect(extractPidFromUrl(undefined)).toBeUndefined();
    expect(extractPidFromUrl('')).toBeUndefined();
  });
});

describe('extractAgentSlug (#52)', () => {
  it('returns a bare slug unchanged', () => {
    expect(extractAgentSlug('paige-mcguirk')).toBe('paige-mcguirk');
  });

  it('pulls the slug out of a full agent profile URL', () => {
    expect(extractAgentSlug('https://www.compass.com/agents/paige-mcguirk/')).toBe(
      'paige-mcguirk'
    );
  });

  it('pulls the slug out of an /agents/<slug>/ path (with or without trailing slash)', () => {
    expect(extractAgentSlug('/agents/paige-mcguirk/')).toBe('paige-mcguirk');
    expect(extractAgentSlug('/agents/paige-mcguirk')).toBe('paige-mcguirk');
  });

  it('ignores query strings and fragments on a profile URL', () => {
    expect(
      extractAgentSlug('https://www.compass.com/agents/paige-mcguirk/?foo=1#bar')
    ).toBe('paige-mcguirk');
  });

  it('trims surrounding whitespace', () => {
    expect(extractAgentSlug('  paige-mcguirk  ')).toBe('paige-mcguirk');
  });

  it('throws on empty / missing input', () => {
    expect(() => extractAgentSlug('')).toThrow(/slug/i);
    expect(() => extractAgentSlug('   ')).toThrow(/slug/i);
  });

  it('throws when a compass URL is not an /agents/ profile URL', () => {
    expect(() =>
      extractAgentSlug('https://www.compass.com/homedetails/foo/abc_lid/')
    ).toThrow(/agents/);
  });
});

describe('agentProfilePath (#52)', () => {
  it('builds the /agents/<slug>/ path from a slug', () => {
    expect(agentProfilePath('paige-mcguirk')).toBe('/agents/paige-mcguirk/');
  });

  it('accepts a full profile URL and reduces it to the path', () => {
    expect(
      agentProfilePath('https://www.compass.com/agents/paige-mcguirk/')
    ).toBe('/agents/paige-mcguirk/');
  });
});

describe('locationToSlug', () => {
  it('converts "Brooklyn, NY" to brooklyn-ny', () => {
    expect(locationToSlug('Brooklyn, NY')).toBe('brooklyn-ny');
  });

  it('lowercases and collapses whitespace', () => {
    expect(locationToSlug('New York City')).toBe('new-york-city');
  });

  it('passes ZIP codes through as digits', () => {
    expect(locationToSlug('94110')).toBe('94110');
  });

  it('trims leading and trailing separators', () => {
    expect(locationToSlug('--Park Slope--')).toBe('park-slope');
  });
});
