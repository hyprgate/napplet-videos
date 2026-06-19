import type {
  RuntimePlaybackContext,
  RuntimePlaybackQueueItem,
  RuntimePlaybackSource,
  RuntimePlayerControl,
} from '@hyprgate/utils';
import { isShortVideo, type VideoEntry } from './movie-store.js';

export function movieVideoKind(video: VideoEntry): 'hls' | 'video' {
  return video.url.toLowerCase().includes('.m3u8') ? 'hls' : 'video';
}

export function movieVideoKindLabel(video: VideoEntry): string {
  return isShortVideo(video) ? 'Short' : 'Long form';
}

export function movieAspectRatio(video: VideoEntry): number {
  return isShortVideo(video) ? 9 / 16 : 16 / 9;
}

export function buildMoviePlaybackRequest(
  video: VideoEntry,
  visibleVideos: VideoEntry[],
): RuntimePlaybackSource {
  const playable = visibleVideos.filter((candidate) => candidate.url);
  const total = playable.length;
  const queue: RuntimePlaybackQueueItem[] = playable.map((candidate, index) => ({
    url: candidate.url,
    kind: movieVideoKind(candidate),
    title: candidate.title || 'Video',
    album: 'NIP-71 Videos',
    artworkUrl: candidate.thumbnail ?? undefined,
    duration: candidate.duration ?? undefined,
    aspectRatio: movieAspectRatio(candidate),
    live: false,
    loop: isShortVideo(candidate),
    context: {
      label: 'NIP-71 Videos',
      detail: movieVideoKindLabel(candidate),
      index,
      total,
    },
  }));
  const queueIndex = playable.findIndex((candidate) => candidate.id === video.id);
  const controls: RuntimePlayerControl[] = ['play', 'pause', 'stop', 'seek', 'setVolume', 'setMuted'];
  if (queue.length > 1) controls.splice(3, 0, 'prev', 'next');

  const context: RuntimePlaybackContext = {
    label: 'NIP-71 Videos',
    detail: movieVideoKindLabel(video),
    ...(queueIndex >= 0 ? { index: queueIndex, total } : {}),
  };

  return {
    url: video.url,
    kind: movieVideoKind(video),
    title: video.title || 'Video',
    album: 'NIP-71 Videos',
    artworkUrl: video.thumbnail ?? undefined,
    duration: video.duration ?? undefined,
    aspectRatio: movieAspectRatio(video),
    context,
    queue,
    queueIndex: queueIndex >= 0 ? queueIndex : undefined,
    capabilities: controls,
    autoplay: true,
    live: false,
    loop: isShortVideo(video),
  };
}
