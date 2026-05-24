import { describe, it, expect } from 'vitest';
import { locationToSlug, urlToPath } from '../src/url.js';

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
