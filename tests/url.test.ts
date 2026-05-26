import { describe, it, expect } from 'vitest';
import { extractPidFromUrl, locationToSlug, urlToPath } from '../src/url.js';

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
