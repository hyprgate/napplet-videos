import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildMoviePageFilter,
  filterVisibleVideos,
  isShortVideo,
  movieStore,
  parseNip71Video,
  popularHashtags,
  shouldContinuePagingForVisibleVideos,
} from './movie-store.js';
import type { NostrEvent } from '@hyprgate/types';

function makeEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: 'test-id',
    pubkey: 'test-pubkey',
    created_at: 1700000000,
    kind: 34235,
    tags: [
      ['d', 'video-1'],
      ['title', 'Test Video'],
      ['imeta', 'url https://example.com/video.m3u8', 'image https://example.com/thumb.jpg', 'duration 120'],
    ],
    content: '',
    sig: 'test-sig',
    ...overrides,
  };
}

describe('parseNip71Video', () => {
  it('parses valid event with imeta tag containing url, image, duration', () => {
    const video = parseNip71Video(makeEvent());
    expect(video).not.toBeNull();
    expect(video!.id).toBe('video-1');
    expect(video!.title).toBe('Test Video');
    expect(video!.url).toBe('https://example.com/video.m3u8');
    expect(video!.thumbnail).toBe('https://example.com/thumb.jpg');
    expect(video!.duration).toBe(120);
    expect(video!.kind).toBe(34235);
    expect(video!.pubkey).toBe('test-pubkey');
    expect(video!.createdAt).toBe(1700000000);
  });

  it('parses thumbnail image when metadata is split across multiple imeta tags', () => {
    const video = parseNip71Video(makeEvent({
      tags: [
        ['d', 'video-1'],
        ['title', 'Split imeta video'],
        ['imeta', 'url https://example.com/video.m3u8', 'duration 120'],
        ['imeta', 'image https://example.com/thumb.jpg'],
      ],
    }));

    expect(video).not.toBeNull();
    expect(video!.url).toBe('https://example.com/video.m3u8');
    expect(video!.thumbnail).toBe('https://example.com/thumb.jpg');
    expect(video!.duration).toBe(120);
  });

  it('parses thumbnails from imeta thumb and standalone thumb/image tags', () => {
    const imetaThumb = parseNip71Video(makeEvent({
      tags: [
        ['d', 'video-1'],
        ['imeta', 'url https://example.com/video.m3u8', 'thumb https://example.com/thumb.webp'],
      ],
    }));
    const tagThumb = parseNip71Video(makeEvent({
      tags: [
        ['d', 'video-2'],
        ['url', 'https://example.com/video.mp4'],
        ['thumb', 'https://example.com/thumb.jpg'],
      ],
    }));
    const tagImage = parseNip71Video(makeEvent({
      tags: [
        ['d', 'video-3'],
        ['url', 'https://example.com/video.mp4'],
        ['image', 'https://example.com/image.jpg'],
      ],
    }));

    expect(imetaThumb!.thumbnail).toBe('https://example.com/thumb.webp');
    expect(tagThumb!.thumbnail).toBe('https://example.com/thumb.jpg');
    expect(tagImage!.thumbnail).toBe('https://example.com/image.jpg');
  });

  it('returns null when d-tag is missing', () => {
    const event = makeEvent({
      tags: [['title', 'Test Video'], ['imeta', 'url https://example.com/video.m3u8']],
    });
    expect(parseNip71Video(event)).toBeNull();
  });

  it('returns null when no imeta and no url tag', () => {
    const event = makeEvent({
      tags: [['d', 'video-1'], ['title', 'Test Video']],
    });
    expect(parseNip71Video(event)).toBeNull();
  });

  it('falls back to url tag when no imeta URL', () => {
    const event = makeEvent({
      tags: [
        ['d', 'video-1'],
        ['title', 'Fallback Video'],
        ['url', 'https://example.com/fallback.mp4'],
      ],
    });
    const video = parseNip71Video(event);
    expect(video).not.toBeNull();
    expect(video!.url).toBe('https://example.com/fallback.mp4');
  });

  it('returns VideoEntry with thumbnail null when imeta has no image field', () => {
    const event = makeEvent({
      tags: [
        ['d', 'video-1'],
        ['title', 'No Thumb'],
        ['imeta', 'url https://example.com/video.m3u8', 'duration 60'],
      ],
    });
    const video = parseNip71Video(event);
    expect(video!.thumbnail).toBeNull();
  });

  it('returns kind 34235 for horizontal video', () => {
    const video = parseNip71Video(makeEvent({ kind: 34235 }));
    expect(video!.kind).toBe(34235);
  });

  it('returns kind 34236 for vertical video', () => {
    const video = parseNip71Video(makeEvent({ kind: 34236 }));
    expect(video!.kind).toBe(34236);
  });

  it('correctly joins remaining parts after key for url with spaces', () => {
    const event = makeEvent({
      tags: [
        ['d', 'video-1'],
        ['title', 'Spaced URL'],
        ['imeta', 'url https://example.com/video with spaces.m3u8'],
      ],
    });
    const video = parseNip71Video(event);
    expect(video!.url).toBe('https://example.com/video with spaces.m3u8');
  });

  it('returns empty title when title tag is absent', () => {
    const event = makeEvent({
      tags: [
        ['d', 'video-1'],
        ['imeta', 'url https://example.com/video.m3u8'],
      ],
    });
    const video = parseNip71Video(event);
    expect(video!.title).toBe('');
  });

  it('returns duration null when imeta has no duration field', () => {
    const event = makeEvent({
      tags: [
        ['d', 'video-1'],
        ['imeta', 'url https://example.com/video.m3u8'],
      ],
    });
    const video = parseNip71Video(event);
    expect(video!.duration).toBeNull();
  });

  it('parses the NIP-89 client tag value', () => {
    const event = makeEvent({
      tags: [
        ['d', 'video-1'],
        ['imeta', 'url https://example.com/video.m3u8'],
        ['client', 'Amethyst', '31990:abc:def'],
      ],
    });
    expect(parseNip71Video(event)!.client).toBe('Amethyst');
  });

  it('returns null client when no client tag is present', () => {
    expect(parseNip71Video(makeEvent())!.client).toBeNull();
  });

  it('collects normalized, de-duplicated hashtags from t tags', () => {
    const event = makeEvent({
      tags: [
        ['d', 'video-1'],
        ['imeta', 'url https://example.com/video.m3u8'],
        ['t', 'Nostr'],
        ['t', '#bitcoin'],
        ['t', 'nostr'],
      ],
    });
    expect(parseNip71Video(event)!.hashtags).toEqual(['nostr', 'bitcoin']);
  });
});

describe('popularHashtags', () => {
  function videoWithTags(id: string, hashtags: string[]) {
    return parseNip71Video(makeEvent({
      tags: [
        ['d', id],
        ['imeta', `url https://example.com/${id}.mp4`],
        ...hashtags.map((tag) => ['t', tag]),
      ],
    }))!;
  }

  it('ranks hashtags by frequency, then alphabetically, and respects the limit', () => {
    const videos = [
      videoWithTags('a', ['nostr', 'bitcoin']),
      videoWithTags('b', ['nostr', 'art']),
      videoWithTags('c', ['nostr', 'bitcoin']),
    ];
    expect(popularHashtags(videos, 2)).toEqual([
      { tag: 'nostr', count: 3 },
      { tag: 'bitcoin', count: 2 },
    ]);
  });

  it('returns an empty list when no videos carry hashtags', () => {
    expect(popularHashtags([videoWithTags('a', [])])).toEqual([]);
  });
});

describe('movieStore', () => {
  beforeEach(() => {
    movieStore.reset();
  });

  it('addVideo + getVideos returns added entries', () => {
    const video = parseNip71Video(makeEvent())!;
    movieStore.addVideo(video);
    const videos = movieStore.getVideos();
    expect(videos.some(v => v.id === 'video-1')).toBe(true);
  });

  it('addVideo with duplicate id replaces existing', () => {
    const video1 = parseNip71Video(makeEvent())!;
    movieStore.addVideo(video1);

    const updatedEvent = makeEvent({
      tags: [
        ['d', 'video-1'],
        ['title', 'Updated Video'],
        ['imeta', 'url https://example.com/updated.m3u8'],
      ],
    });
    const video2 = parseNip71Video(updatedEvent)!;
    movieStore.addVideo(video2);

    const found = movieStore.getVideo('video-1');
    expect(found!.title).toBe('Updated Video');
  });

  it('setLoading/isLoading works correctly', () => {
    movieStore.setLoading(false);
    expect(movieStore.isLoading()).toBe(false);
    movieStore.setLoading(true);
    expect(movieStore.isLoading()).toBe(true);
  });

  it('getVideos sorts by newest createdAt first', () => {
    movieStore.addVideo(parseNip71Video(makeEvent({ id: 'old-event', created_at: 1000, tags: [['d', 'old'], ['imeta', 'url https://example.com/old.mp4']] }))!);
    movieStore.addVideo(parseNip71Video(makeEvent({ id: 'new-event', created_at: 3000, tags: [['d', 'new'], ['imeta', 'url https://example.com/new.mp4']] }))!);
    movieStore.addVideo(parseNip71Video(makeEvent({ id: 'middle-event', created_at: 2000, tags: [['d', 'middle'], ['imeta', 'url https://example.com/middle.mp4']] }))!);

    expect(movieStore.getVideos().map((video) => video.id)).toEqual(['new', 'middle', 'old']);
  });
});

describe('movie feed helpers', () => {
  it('classifies kind 34236 and <=60 second videos as shorts', () => {
    const vertical = parseNip71Video(makeEvent({ kind: 34236 }))!;
    const shortHorizontal = parseNip71Video(makeEvent({
      tags: [['d', 'short'], ['imeta', 'url https://example.com/short.mp4', 'duration 60']],
    }))!;
    const longHorizontal = parseNip71Video(makeEvent({
      tags: [['d', 'long'], ['imeta', 'url https://example.com/long.mp4', 'duration 61']],
    }))!;

    expect(isShortVideo(vertical)).toBe(true);
    expect(isShortVideo(shortHorizontal)).toBe(true);
    expect(isShortVideo(longHorizontal)).toBe(false);
  });

  it('filters visible videos according to short and long form toggles', () => {
    const short = parseNip71Video(makeEvent({
      kind: 34236,
      tags: [['d', 'short'], ['imeta', 'url https://example.com/short.mp4']],
    }))!;
    const long = parseNip71Video(makeEvent({
      kind: 34235,
      tags: [['d', 'long'], ['imeta', 'url https://example.com/long.mp4', 'duration 300']],
    }))!;

    expect(filterVisibleVideos([short, long], { showShorts: false, showLongForm: true })).toEqual([long]);
    expect(filterVisibleVideos([short, long], { showShorts: true, showLongForm: false })).toEqual([short]);
    expect(filterVisibleVideos([short, long], { showShorts: true, showLongForm: true })).toEqual([short, long]);
  });

  it('builds NIP-71 page filters with an until cursor for older pages', () => {
    expect(buildMoviePageFilter()).toEqual({ kinds: [34235, 34236], limit: 100 });
    expect(buildMoviePageFilter(1234)).toEqual({ kinds: [34235, 34236], limit: 100, until: 1234 });
  });

  it('continues paging when long form is visible, shorts are hidden, and a batch added no visible videos', () => {
    expect(shouldContinuePagingForVisibleVideos({
      showShorts: false,
      showLongForm: true,
      visibleCount: 0,
      pageEventCount: 100,
      hasMore: true,
    })).toBe(true);
  });

  it('stops automatic long-form search when results are visible or the source is exhausted', () => {
    expect(shouldContinuePagingForVisibleVideos({
      showShorts: false,
      showLongForm: true,
      visibleCount: 1,
      pageEventCount: 100,
      hasMore: true,
    })).toBe(false);
    expect(shouldContinuePagingForVisibleVideos({
      showShorts: false,
      showLongForm: true,
      visibleCount: 0,
      pageEventCount: 0,
      hasMore: true,
    })).toBe(false);
    expect(shouldContinuePagingForVisibleVideos({
      showShorts: false,
      showLongForm: true,
      visibleCount: 0,
      pageEventCount: 100,
      hasMore: false,
    })).toBe(false);
  });
});
