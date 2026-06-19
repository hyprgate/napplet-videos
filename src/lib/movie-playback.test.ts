import { describe, expect, it } from 'vitest';
import { buildMoviePlaybackRequest } from './movie-playback.js';
import type { VideoEntry } from './movie-store.js';

function makeVideo(overrides: Partial<VideoEntry> = {}): VideoEntry {
  return {
    id: 'movie-1',
    title: 'Phase 95 Movie',
    url: 'https://media.example.test/phase-95.mp4',
    thumbnail: null,
    duration: 120,
    kind: 34235,
    pubkey: 'b'.repeat(64),
    createdAt: 1700000000,
    client: null,
    hashtags: [],
    ...overrides,
  };
}

describe('buildMoviePlaybackRequest', () => {
  it('creates display-only movie playback context without stale chat metadata', () => {
    const video = makeVideo();
    const request = buildMoviePlaybackRequest(video, [video]);

    expect(request).toEqual(expect.objectContaining({
      title: 'Phase 95 Movie',
      live: false,
      context: {
        label: 'NIP-71 Videos',
        detail: 'Long form',
        index: 0,
        total: 1,
      },
    }));
    expect(request.context).not.toHaveProperty('chat');
    expect(request.queue).toHaveLength(1);
    expect(request.queue?.[0]).toEqual(expect.objectContaining({
      title: 'Phase 95 Movie',
      live: false,
      context: {
        label: 'NIP-71 Videos',
        detail: 'Long form',
        index: 0,
        total: 1,
      },
    }));
    expect(request.queue?.[0]?.context).not.toHaveProperty('chat');
  });

  it('marks every queued movie item as non-live and chat-free', () => {
    const first = makeVideo({ id: 'movie-1', title: 'First Movie' });
    const second = makeVideo({
      id: 'movie-2',
      title: 'Second Movie',
      url: 'https://media.example.test/second.m3u8',
      duration: 45,
      kind: 34236,
    });

    const request = buildMoviePlaybackRequest(second, [first, second]);

    expect(request.live).toBe(false);
    expect(request.queueIndex).toBe(1);
    expect(request.capabilities).toEqual(['play', 'pause', 'stop', 'prev', 'next', 'seek', 'setVolume', 'setMuted']);
    for (const item of request.queue ?? []) {
      expect(item.live).toBe(false);
      expect(item.context).not.toHaveProperty('chat');
    }
  });
});
