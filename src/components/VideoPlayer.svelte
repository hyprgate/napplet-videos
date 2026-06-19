<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    loadResourceObjectUrl,
    requestRuntimePlayback,
    releaseRuntimePlayback,
    type ResourceObjectUrlSubscription,
  } from '@hyprgate/utils';
  import type { VideoEntry } from '../lib/movie-store.js';

  let { video, onback }: {
    video: VideoEntry;
    onback: () => void;
  } = $props();

  let showPlayOverlay = $state(true);
  let runtimeSessionId: string | null = null;
  let resourceSession: ResourceObjectUrlSubscription | null = null;
  let resourceUrl: string | null = $state(null);
  let playbackMode: 'idle' | 'resource' | 'runtime' = $state('idle');
  let error: string | null = $state(null);
  let playbackRequestToken = 0;
  let destroyed = false;
  let requestInFlight = false;

  function videoKind(): 'hls' | 'video' {
    return video.url.toLowerCase().includes('.m3u8') ? 'hls' : 'video';
  }

  async function requestRuntimeFallback(token: number, reason: unknown) {
    try {
      const result = await requestRuntimePlayback({
        url: video.url,
        kind: videoKind(),
        title: video.title || 'Video',
        album: 'NIP-71 Videos',
        artworkUrl: video.thumbnail ?? undefined,
        duration: video.duration ?? undefined,
        context: {
          label: 'NIP-71 Videos',
          detail: video.kind === 34236 ? 'Vertical video' : 'Video',
        },
        capabilities: ['play', 'pause', 'stop', 'seek', 'setVolume', 'setMuted'],
        autoplay: true,
        live: false,
      });
      if (destroyed || token !== playbackRequestToken) {
        void releaseRuntimePlayback(result.sessionId).catch((releaseError) => {
          console.warn('[movie] stale player.release failed', releaseError);
        });
        return;
      }
      runtimeSessionId = result.sessionId;
      showPlayOverlay = false;
      playbackMode = 'runtime';
      error = null;
    } catch (err) {
      if (destroyed || token !== playbackRequestToken) return;
      const resourceReason = reason instanceof Error ? reason.message : String(reason || 'resource failed');
      const runtimeReason = err instanceof Error ? err.message : 'runtime playback failed';
      error = `resource failed: ${resourceReason}; runtime failed: ${runtimeReason}`;
      console.warn('[movie] resource and player.requestPlayback failed', reason, err);
    } finally {
      if (token === playbackRequestToken) requestInFlight = false;
    }
  }

  function handlePlay() {
    if (requestInFlight) return;
    const token = ++playbackRequestToken;
    requestInFlight = true;
    error = null;
    resourceUrl = null;
    resourceSession?.close();
    resourceSession = loadResourceObjectUrl(video.url, (url) => {
      if (destroyed || token !== playbackRequestToken || !url) return;
      resourceUrl = url;
      showPlayOverlay = false;
      playbackMode = 'resource';
      requestInFlight = false;
    }, {
      onError: (resourceError) => {
        if (destroyed || token !== playbackRequestToken) return;
        void requestRuntimeFallback(token, resourceError);
      },
    });
  }

  onDestroy(() => {
    destroyed = true;
    playbackRequestToken++;
    resourceSession?.close();
    resourceSession = null;
    if (runtimeSessionId) void releaseRuntimePlayback(runtimeSessionId);
    runtimeSessionId = null;
  });
</script>

<div class="h-screen w-screen bg-bg-base flex flex-col">
  <div class="p-3">
    <button
      class="text-sm text-text-muted hover:text-text-primary transition-colors"
      onclick={onback}
    >
      &larr; Back
    </button>
  </div>

  <div class="flex-1 flex items-center justify-center relative">
    <div class="w-full h-full flex items-center justify-center bg-bg-surface text-text-muted text-sm">
      {#if resourceUrl}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video src={resourceUrl} controls autoplay playsinline class="w-full h-full object-contain bg-bg-base"></video>
      {:else if !showPlayOverlay && !error}
        {playbackMode === 'runtime' ? 'playing in shell' : 'loading resource'}
      {/if}
    </div>

    {#if showPlayOverlay}
      <button
        class="absolute inset-0 flex items-center justify-center bg-bg-base/50 cursor-pointer"
        onclick={handlePlay}
      >
        <div class="w-16 h-16 rounded-full bg-text-primary/20 flex items-center justify-center text-text-primary text-3xl hover:bg-text-primary/30 transition-colors">
          &#9654;
        </div>
      </button>
    {/if}

    {#if error}
      <div class="absolute bottom-4 left-4 right-4 text-sm text-accent-red bg-bg-base/70 p-2 rounded">
        {error}
      </div>
    {/if}
  </div>

  <div class="p-3">
    <div class="text-lg font-bold text-text-primary">{video.title || 'Untitled'}</div>
    <div class="text-xs text-text-muted">mode: {playbackMode === 'resource' ? 'NAP-RESOURCE' : playbackMode}</div>
  </div>
</div>
