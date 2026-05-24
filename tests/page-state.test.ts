import { describe, it, expect } from 'vitest';
import {
  extractBalancedObject,
  extractGlobalAssign,
  extractInitialData,
  extractUc,
} from '../src/page-state.js';

describe('extractBalancedObject', () => {
  it('parses a flat JSON object starting at the brace', () => {
    const text = 'noise {"a":1,"b":"hello"} trailing';
    expect(extractBalancedObject(text, 6)).toEqual({ a: 1, b: 'hello' });
  });

  it('handles nested braces inside string literals', () => {
    // The `}` inside the string shouldn't close the outer object.
    const text = '{"k":"a}b","n":{"x":1}}';
    expect(extractBalancedObject(text, 0)).toEqual({ k: 'a}b', n: { x: 1 } });
  });

  it('respects escaped quotes inside strings', () => {
    const text = '{"q":"he said \\"hi\\""}';
    expect(extractBalancedObject(text, 0)).toEqual({ q: 'he said "hi"' });
  });

  it('returns null when the cursor is not at a brace', () => {
    expect(extractBalancedObject('abc {x:1}', 0)).toBeNull();
  });
});

describe('extractGlobalAssign', () => {
  it('extracts `global.<name> = {…}`', () => {
    const html =
      '<html>...<script>global.uc = {"foo":42,"nested":{"k":"v"}};</script>';
    expect(extractGlobalAssign(html, 'uc')).toEqual({
      foo: 42,
      nested: { k: 'v' },
    });
  });

  it('extracts `window.<name> = {…}` as well', () => {
    const html = '<script>window.__INITIAL_DATA__ = {"props":{"x":1}};</script>';
    expect(extractGlobalAssign(html, '__INITIAL_DATA__')).toEqual({
      props: { x: 1 },
    });
  });

  it('returns null when the assignment is missing', () => {
    expect(extractGlobalAssign('<html>nothing</html>', 'uc')).toBeNull();
  });

  it('returns null when the object is malformed', () => {
    expect(extractGlobalAssign('<script>global.uc = {bad json};</script>', 'uc')).toBeNull();
  });
});

describe('extractUc / extractInitialData wrappers', () => {
  it('extractUc finds the uc global', () => {
    const html = '<script>global.uc = {"geoId":"nyc"};</script>';
    expect(extractUc(html)).toEqual({ geoId: 'nyc' });
  });

  it('extractInitialData finds the __INITIAL_DATA__ global', () => {
    const html =
      '<script>window.__INITIAL_DATA__ = {"props":{"listingRelation":{"listing":{"listingIdSHA":"abc"}}}};</script>';
    expect(extractInitialData(html)).toEqual({
      props: { listingRelation: { listing: { listingIdSHA: 'abc' } } },
    });
  });
});
