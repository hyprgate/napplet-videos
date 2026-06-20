// NIP-71 video event state — pure TypeScript, no Svelte runes.

import type { NostrEvent, NostrFilter } from '@hyprgate/types';
import { clientTagValue } from '@hyprgate/utils';

export const NIP71_VIDEO_KINDS = [34235, 34236] as const;
export const MOVIE_PAGE_LIMIT = 48;
export const MOVIE_RETAINED_VIDEO_LIMIT = 192;
export const MOVIE_RENDERED_VIDEO_LIMIT = 96;
export const MOVIE_VISIBLE_TARGET_MAX = 20;
export const MOVIE_LOW_VISIBLE_PAGE_LIMIT = 3;

export interface VideoEntry {
  id: string;           // d-tag
  title: string;        // title tag
  url: string;          // video URL from imeta or url tag
  thumbnail: string | null;  // image from imeta
  duration: number | null;   // seconds from imeta
  kind: 34235 | 34236;      // horizontal or vertical
  pubkey: string;
  createdAt: number;
  client: string | null;     // NIP-89 client tag value (publishing app)
  hashtags: string[];        // `t` tag values, lowercased
}

export interface VideoVisibilityFilter {
  showShorts: boolean;
  showLongForm: boolean;
}

export interface ContinuePagingInput extends VideoVisibilityFilter {
  visibleCount: number;
  pageEventCount: number;
  hasMore: boolean;
}

export interface VisiblePagingDecisionInput extends ContinuePagingInput {
  lowVisiblePageStreak: number;
  retainedVideoCount: number;
  retainedVideoLimit?: number;
  lowVisiblePageLimit?: number;
}

export interface VisiblePagingDecision {
  continuePaging: boolean;
  nextLowVisiblePageStreak: number;
  exhaustedBySafetyCap: boolean;
}

export function isShortVideo(video: VideoEntry): boolean {
  return video.kind === 34236 || (video.duration !== null && video.duration <= 60);
}

export function filterVisibleVideos(
  videos: VideoEntry[],
  filter: VideoVisibilityFilter,
): VideoEntry[] {
  return videos.filter((video) => {
    const short = isShortVideo(video);
    return short ? filter.showShorts : filter.showLongForm;
  });
}

export function buildMoviePageFilter(until?: number): NostrFilter {
  return {
    kinds: [...NIP71_VIDEO_KINDS],
    limit: MOVIE_PAGE_LIMIT,
    ...(until !== undefined ? { until } : {}),
  };
}

export function shouldContinuePagingForVisibleVideos(input: ContinuePagingInput): boolean {
  return input.hasMore
    && !input.showShorts
    && input.showLongForm
    && input.visibleCount === 0
    && input.pageEventCount > 0;
}

export function getVisiblePagingDecision(input: VisiblePagingDecisionInput): VisiblePagingDecision {
  const retainedVideoLimit = input.retainedVideoLimit ?? MOVIE_RETAINED_VIDEO_LIMIT;
  const lowVisiblePageLimit = input.lowVisiblePageLimit ?? MOVIE_LOW_VISIBLE_PAGE_LIMIT;
  const exhaustedBySafetyCap = input.retainedVideoCount >= retainedVideoLimit;
  const lowVisiblePage = shouldContinuePagingForVisibleVideos(input);
  const nextLowVisiblePageStreak = lowVisiblePage ? input.lowVisiblePageStreak + 1 : 0;

  return {
    continuePaging: lowVisiblePage
      && !exhaustedBySafetyCap
      && input.lowVisiblePageStreak < lowVisiblePageLimit,
    nextLowVisiblePageStreak,
    exhaustedBySafetyCap,
  };
}

function firstTagValue(tags: string[][], name: string): string | undefined {
  return tags.find((tag) => tag[0] === name)?.[1]?.trim() || undefined;
}

function firstImetaValue(imetaTag: string[], key: string): string | undefined {
  return imetaTag
    .slice(1)
    .find((value) => value.startsWith(`${key} `))
    ?.split(' ')
    .slice(1)
    .join(' ')
    .trim() || undefined;
}

/**
 * Parse a NIP-71 video event (kind 34235 or 34236) into a VideoEntry.
 * Returns null if required fields (d-tag, video URL) are missing.
 *
 * Pitfall 3: imeta tag values use NIP-92 format — space-separated "key value" strings.
 */
export function parseNip71Video(event: NostrEvent): VideoEntry | null {
  const id = firstTagValue(event.tags, 'd');
  if (!id) return null;

  const title = firstTagValue(event.tags, 'title') ?? '';

  // Extract URL/image from imeta tags (NIP-92 format). Publishers often split
  // video and thumbnail metadata across separate imeta tags.
  const imetaTags = event.tags.filter(t => t[0] === 'imeta');
  let url: string | undefined;
  let thumbnail: string | null = null;
  let duration: number | null = null;

  for (const imetaTag of imetaTags) {
    url ??= firstImetaValue(imetaTag, 'url');
    thumbnail ??= firstImetaValue(imetaTag, 'image') ?? firstImetaValue(imetaTag, 'thumb') ?? null;
    const durationStr = firstImetaValue(imetaTag, 'duration');
    if (durationStr) {
      const parsed = parseInt(durationStr, 10);
      if (!isNaN(parsed)) duration = parsed;
    }
  }

  thumbnail ??= firstTagValue(event.tags, 'thumb') ?? firstTagValue(event.tags, 'image') ?? null;

  // Fallback to url tag if no imeta URL
  if (!url) {
    url = firstTagValue(event.tags, 'url');
  }

  // No playable video URL — skip
  if (!url) return null;

  // NIP-89 client tag: ["client", "<name>", ...] — publishing application
  const client = clientTagValue(event);

  // `t` tags are topic hashtags. Normalize to lowercase, drop the leading '#'.
  const hashtags: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== 't') continue;
    const value = tag[1]?.trim().replace(/^#+/, '').toLowerCase();
    if (value && !hashtags.includes(value)) hashtags.push(value);
  }

  return {
    id,
    title,
    url,
    thumbnail,
    duration,
    kind: event.kind as 34235 | 34236,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    client,
    hashtags,
  };
}

export interface HashtagCount {
  tag: string;
  count: number;
}

/**
 * Tally hashtags across the given videos and return the most frequent ones,
 * highest count first (ties broken alphabetically for stable ordering).
 */
export function popularHashtags(videos: VideoEntry[], limit = 8): HashtagCount[] {
  const counts = new Map<string, number>();
  for (const video of videos) {
    for (const tag of video.hashtags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, limit);
}

const videos = new Map<string, VideoEntry>();
let loading = true;

export const movieStore = {
  addVideo(video: VideoEntry): boolean {
    const existing = videos.get(video.id);
    videos.set(video.id, video);
    return existing !== video;
  },
  getVideos(): VideoEntry[] {
    return Array.from(videos.values()).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  },
  getVideo(id: string): VideoEntry | undefined {
    return videos.get(id);
  },
  trimToLimit(limit: number): void {
    if (videos.size <= limit) return;
    for (const video of this.getVideos().slice(limit)) {
      videos.delete(video.id);
    }
  },
  isLoading(): boolean {
    return loading;
  },
  setLoading(v: boolean): void {
    loading = v;
  },
  reset(): void {
    videos.clear();
    loading = true;
  },
};
