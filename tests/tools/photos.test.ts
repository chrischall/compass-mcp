import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { CompassClient } from '../../src/client.js';
import { formatPhoto, registerPhotosTools } from '../../src/tools/photos.js';
import { createTestHarness, parseToolResult } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as CompassClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

describe('formatPhoto', () => {
  it('lifts originalUrl + thumbnailUrl + dimensions + category', () => {
    expect(
      formatPhoto({
        category: 0,
        originalUrl: 'https://cdn/origin.jpg',
        thumbnailUrl: 'https://cdn/thumb.jpg',
        width: 1920,
        height: 1280,
      })
    ).toEqual({
      url: 'https://cdn/origin.jpg',
      thumbnail_url: 'https://cdn/thumb.jpg',
      width: 1920,
      height: 1280,
      category: 0,
    });
  });

  it('returns null when there are no URLs at all', () => {
    expect(formatPhoto({})).toBeNull();
  });
});

const htmlWithMedia = (media: unknown[]) => {
  const data = {
    props: {
      listingRelation: {
        listing: {
          listingIdSHA: 'abc',
          pageLink: '/homedetails/foo/abc_lid/',
          media,
        },
      },
    },
  };
  return `<html><script>window.__INITIAL_DATA__ = ${JSON.stringify(data)};</script></html>`;
};

describe('compass_get_property_photos tool', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerPhotosTools(server, mockClient)
    );
  });

  it('returns photo entries by default and skips non-zero categories', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithMedia([
        { category: 0, originalUrl: 'https://a/1.jpg', thumbnailUrl: 'https://a/t1.jpg' },
        { category: 1, originalUrl: 'https://a/floorplan.jpg' },
        { category: 0, originalUrl: 'https://a/2.jpg', thumbnailUrl: 'https://a/t2.jpg' },
      ])
    );
    const r = await harness.callTool('compass_get_property_photos', {
      url: '/homedetails/foo/abc_lid/',
    });
    const parsed = parseToolResult<{ count: number; photos: Array<{ url: string }> }>(r);
    expect(parsed.count).toBe(2);
    expect(parsed.photos.map((p) => p.url)).toEqual([
      'https://a/1.jpg',
      'https://a/2.jpg',
    ]);
  });

  it('includes non-photo media when include_all_categories=true', async () => {
    mockFetchHtml.mockResolvedValueOnce(
      htmlWithMedia([
        { category: 0, originalUrl: 'https://a/1.jpg' },
        { category: 1, originalUrl: 'https://a/floorplan.jpg' },
      ])
    );
    const r = await harness.callTool('compass_get_property_photos', {
      url: '/homedetails/foo/abc_lid/',
      include_all_categories: true,
    });
    const parsed = parseToolResult<{ count: number }>(r);
    expect(parsed.count).toBe(2);
  });

  it('returns count=0 when the listing has no media', async () => {
    mockFetchHtml.mockResolvedValueOnce(htmlWithMedia([]));
    const r = await harness.callTool('compass_get_property_photos', {
      url: '/homedetails/foo/abc_lid/',
    });
    const parsed = parseToolResult<{ count: number; photos: unknown[] }>(r);
    expect(parsed.count).toBe(0);
    expect(parsed.photos).toEqual([]);
  });
});
