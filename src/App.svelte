<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    controlRuntimePlayback,
    preloadResourceObjectUrl,
    releaseRuntimePlayback,
    requestRuntimePlayback,
    subscribeRuntimePlayback,
    type RuntimePlayerStatus,
    type RuntimePlayerSubscription,
    type ResourceObjectUrlSubscription,
  } from '@hyprgate/utils';
  import {
    buildMoviePageFilter,
    filterVisibleVideos,
    getVisiblePagingDecision,
    isShortVideo,
    MOVIE_PAGE_LIMIT,
    MOVIE_RENDERED_VIDEO_LIMIT,
    MOVIE_RETAINED_VIDEO_LIMIT,
    MOVIE_VISIBLE_TARGET_MAX,
    movieStore,
    parseNip71Video,
    popularHashtags,
  } from './lib/movie-store.js';
  import {
    getNextMoviePageRequest,
    isMoviePageExhausted,
    MOVIE_PAGE_EMPTY_SETTLE_TIMEOUT_MS,
    MOVIE_PAGE_IDLE_SETTLE_MS,
    MOVIE_PAGE_INITIAL_SETTLE_TIMEOUT_MS,
    shouldQueueMoviePageRequest,
  } from './lib/movie-pagination.js';
  import { buildMoviePlaybackRequest } from './lib/movie-playback.js';
  import { subscribeProfileMetadata, type ProfileContent } from './lib/profile-metadata.js';
  import { subscribeVideoPage } from './lib/video-subscription.js';
  import VideoCard from './components/VideoCard.svelte';
  import type { VideoEntry } from './lib/movie-store.js';
  import type { Subscription } from '@napplet/sdk';
  import type { NostrEvent } from '@hyprgate/types';

  // Version counter pattern for store reactivity
  let version = $state(0);
  function notifyUpdate() { version++; }

  let showShorts = $state(true);
  let showLongForm = $state(true);
  let showNsfw = $state(false);
  let activeHashtag = $state<string | null>(null);
  let allVideos = $derived.by(() => { version; return movieStore.getVideos(); });
  // Videos passing the Shorts/Long-form toggles and the NSFW filter (off by
  // default — #nsfw-tagged videos are hidden unless explicitly enabled).
  let typeVideos = $derived.by(() => {
    const current = allVideos;
    const byType = filterVisibleVideos(current, { showShorts, showLongForm });
    return showNsfw ? byType : byType.filter((video) => !video.hashtags.includes('nsfw'));
  });
  // Final visible set: type-filtered, then narrowed to the active hashtag.
  let videos = $derived.by(() => {
    const tag = activeHashtag;
    return tag === null ? typeVideos : typeVideos.filter((video) => video.hashtags.includes(tag));
  });
  let renderedVideos = $derived(videos.slice(0, MOVIE_RENDERED_VIDEO_LIMIT));
  // Header chips reflect the broad (pre-hashtag) set so you can always pivot.
  // Keep the active tag present even if it has dropped out of the top slots.
  let topHashtags = $derived.by(() => {
    const top = popularHashtags(typeVideos, 8);
    const tag = activeHashtag;
    if (tag !== null && !top.some((entry) => entry.tag === tag)) {
      top.unshift({ tag, count: videos.length });
    }
    return top;
  });
  let loading = $derived.by(() => { version; return movieStore.isLoading(); });
  let loadingMore = $state(false);
  let hasMore = $state(true);

  // Author profiles (kind 0), keyed by pubkey. Reassigned to trigger reactivity.
  const PROFILE_METADATA_BATCH_MS = 80;
  const VIDEO_THUMBNAIL_PRELOAD_LIMIT = 120;
  let profiles = $state<Map<string, ProfileContent>>(new Map());
  const profileSubscriptions = new Set<Subscription>();
  const thumbnailPreloads = new Map<string, ResourceObjectUrlSubscription>();
  const loadingProfilePubkeys = new Set<string>();
  const queuedProfilePubkeys = new Set<string>();
  let profileBatchTimer: ReturnType<typeof setTimeout> | null = null;

  function syncProfileSubscription(): void {
    let queued = false;
    for (const video of allVideos) {
      const pubkey = video.pubkey;
      if (!pubkey || profiles.has(pubkey) || loadingProfilePubkeys.has(pubkey)) continue;
      queuedProfilePubkeys.add(pubkey);
      queued = true;
    }
    if (!queued || profileBatchTimer !== null) return;

    profileBatchTimer = setTimeout(() => {
      profileBatchTimer = null;
      flushProfileMetadataBatch();
    }, PROFILE_METADATA_BATCH_MS);
  }

  function flushProfileMetadataBatch(): void {
    const missingPubkeys = [...queuedProfilePubkeys]
      .filter((pubkey) => !profiles.has(pubkey) && !loadingProfilePubkeys.has(pubkey));
    queuedProfilePubkeys.clear();
    if (missingPubkeys.length === 0) return;

    for (const pubkey of missingPubkeys) loadingProfilePubkeys.add(pubkey);

    try {
      let subscription: Subscription | null = null;
      subscription = subscribeProfileMetadata(
        missingPubkeys,
        (pubkey, profile) => {
          profiles = new Map(profiles).set(pubkey, profile);
          loadingProfilePubkeys.delete(pubkey);
        },
        () => {
          // EOSE only marks the initial burst; live metadata can still arrive later.
        },
      );
      profileSubscriptions.add(subscription);
    } catch {
      for (const pubkey of missingPubkeys) loadingProfilePubkeys.delete(pubkey);
    }
  }

  function syncThumbnailPreloads(): void {
    for (const video of allVideos.slice(0, VIDEO_THUMBNAIL_PRELOAD_LIMIT)) {
      const thumbnail = video.thumbnail;
      if (!thumbnail || thumbnailPreloads.has(thumbnail)) continue;
      thumbnailPreloads.set(thumbnail, preloadResourceObjectUrl(thumbnail));
    }
  }

  $effect(() => {
    // Re-subscribe whenever new authors appear in the loaded set.
    void allVideos;
    syncProfileSubscription();
    syncThumbnailPreloads();
  });

  let activeVideoId = $state<string | null>(null);
  let runtimeSessionId: string | null = null;
  let runtimeSubscription: RuntimePlayerSubscription | null = null;
  let runtimeState = $state<RuntimePlayerStatus | null>(null);
  let runtimeErrorVideoId = $state<string | null>(null);
  let requestInFlight = $state(false);

  let sub: Subscription | null = null;
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let scrollContainer: HTMLDivElement | undefined = $state();
  let loadMoreSentinel: HTMLDivElement | undefined = $state();
  let observer: IntersectionObserver | null = null;
  let oldestSeenCreatedAt: number | null = null;
  let pageRequestId = $state(0);
  let pendingPageRequest = false;
  let lowVisiblePageStreak = 0;
  let pageSettleTimer: ReturnType<typeof setTimeout> | null = null;

  async function toggleActiveVideoPlayback(): Promise<void> {
    if (!runtimeSessionId) return;
    const action = runtimeState === 'playing' || runtimeState === 'loading' ? 'pause' : 'play';
    try {
      const state = await controlRuntimePlayback(runtimeSessionId, action);
      runtimeState = state?.state ?? (action === 'pause' ? 'paused' : 'loading');
    } catch (error) {
      runtimeState = 'error';
      if (activeVideoId) runtimeErrorVideoId = activeVideoId;
      console.warn('[movie] player.control failed', error);
    }
  }

  async function releaseCurrentRuntime(): Promise<void> {
    runtimeSubscription?.close();
    runtimeSubscription = null;
    if (runtimeSessionId) {
      const staleSessionId = runtimeSessionId;
      runtimeSessionId = null;
      await releaseRuntimePlayback(staleSessionId).catch((error) => {
        console.warn('[movie] stale player.release failed', error);
      });
    }
  }

  async function selectVideo(video: VideoEntry): Promise<void> {
    if (requestInFlight) return;
    if (activeVideoId === video.id && runtimeSessionId) {
      await toggleActiveVideoPlayback();
      return;
    }

    requestInFlight = true;
    runtimeErrorVideoId = null;
    activeVideoId = video.id;
    runtimeState = 'loading';
    runtimeSubscription?.close();
    runtimeSubscription = null;
    runtimeSessionId = null;
    try {
      const result = await requestRuntimePlayback(buildMoviePlaybackRequest(video, videos));
      runtimeSessionId = result.sessionId;
      runtimeState = result.state?.state ?? 'loading';
      const sessionId = result.sessionId;
      runtimeSubscription = subscribeRuntimePlayback(sessionId, (state) => {
        if (runtimeSessionId !== sessionId) return;
        if (!state) {
          activeVideoId = null;
          runtimeState = null;
          runtimeSessionId = null;
          runtimeSubscription?.close();
          runtimeSubscription = null;
          return;
        }
        runtimeState = state.state;
      });
    } catch (error) {
      runtimeErrorVideoId = video.id;
      runtimeState = 'error';
      console.warn('[movie] player.requestPlayback failed', error);
    } finally {
      requestInFlight = false;
    }
  }

  function closePageSubscription(): void {
    clearPageSettleTimer();
    sub?.close();
    sub = null;
  }

  function clearPageSettleTimer(): void {
    if (pageSettleTimer === null) return;
    clearTimeout(pageSettleTimer);
    pageSettleTimer = null;
  }

  function noteSeenEvent(event: NostrEvent): void {
    if (oldestSeenCreatedAt === null || event.created_at < oldestSeenCreatedAt) {
      oldestSeenCreatedAt = event.created_at;
    }
  }

  function oldestLoadedVideoCreatedAt(): number | null {
    let oldest = oldestSeenCreatedAt;
    for (const video of movieStore.getVideos()) {
      if (oldest === null || video.createdAt < oldest) oldest = video.createdAt;
    }
    return oldest;
  }

  function visibleVideoCount(): number {
    return filterVisibleVideos(movieStore.getVideos(), { showShorts, showLongForm }).length;
  }

  function wantsLongFormSearch(): boolean {
    return hasMore && !showShorts && showLongForm && visibleVideoCount() === 0;
  }

  function hasVisibleVideoType(): boolean {
    return showShorts || showLongForm;
  }

  function isNearLoadBoundary(): boolean {
    if (!scrollContainer) return false;
    if (scrollContainer.scrollHeight <= scrollContainer.clientHeight + 1) return true;
    const remaining = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
    return remaining < 1200;
  }

  function loadNextMoviePage(): void {
    if (shouldQueueMoviePageRequest({
      isLoading: movieStore.isLoading(),
      loadingMore,
      hasMore,
    })) {
      pendingPageRequest = true;
      return;
    }

    const pageRequest = getNextMoviePageRequest({
      isLoading: movieStore.isLoading(),
      loadingMore,
      hasMore,
      loadedVideoCount: movieStore.getVideos().length,
      oldestSeenCreatedAt,
    });
    if (!pageRequest) return;

    const { initialLoad, until, cursorBefore } = pageRequest;
    const requestId = ++pageRequestId;
    let pageEventCount = 0;
    let pageSettled = false;
    pendingPageRequest = false;

    closePageSubscription();
    loadingMore = !initialLoad;
    movieStore.setLoading(true);
    notifyUpdate();

    function settlePage(): void {
      if (pageSettled || requestId !== pageRequestId) return;
      pageSettled = true;
      closePageSubscription();

      const settledOldestSeenCreatedAt = oldestLoadedVideoCreatedAt();
      if (settledOldestSeenCreatedAt !== null) oldestSeenCreatedAt = settledOldestSeenCreatedAt;
      movieStore.trimToLimit(MOVIE_RETAINED_VIDEO_LIMIT);
      const loadedVideoCount = movieStore.getVideos().length;
      const effectivePageEventCount = Math.max(pageEventCount, loadedVideoCount > 0 ? 1 : 0);

      if (isMoviePageExhausted({
        pageEventCount: effectivePageEventCount,
        oldestSeenCreatedAt: settledOldestSeenCreatedAt,
        cursorBefore,
        loadedVideoCount,
        pageLimit: MOVIE_PAGE_LIMIT,
      })) {
        hasMore = false;
      }

      loadingMore = false;
      movieStore.setLoading(false);
      notifyUpdate();

      const visibleCountAfterPage = visibleVideoCount();
      const pagingDecision = getVisiblePagingDecision({
        showShorts,
        showLongForm,
        visibleCount: visibleCountAfterPage,
        pageEventCount: effectivePageEventCount,
        hasMore,
        lowVisiblePageStreak,
        retainedVideoCount: loadedVideoCount,
      });
      lowVisiblePageStreak = pagingDecision.nextLowVisiblePageStreak;
      if (pagingDecision.exhaustedBySafetyCap) {
        hasMore = false;
      }

      const shouldTopUpGrid = hasMore
        && hasVisibleVideoType()
        && isNearLoadBoundary()
        && visibleCountAfterPage < MOVIE_VISIBLE_TARGET_MAX;
      const shouldFollowQueuedBoundary = pendingPageRequest;
      pendingPageRequest = false;

      if (hasMore && (shouldFollowQueuedBoundary || pagingDecision.continuePaging || shouldTopUpGrid)) {
        queueMicrotask(loadNextMoviePage);
      }
    }

    function schedulePageSettle(delay: number): void {
      clearPageSettleTimer();
      pageSettleTimer = setTimeout(settlePage, delay);
    }

    sub = subscribeVideoPage(
      buildMoviePageFilter(until),
      (event) => {
        if (requestId !== pageRequestId) return;
        pageEventCount++;
        schedulePageSettle(MOVIE_PAGE_IDLE_SETTLE_MS);
        noteSeenEvent(event);
        const video = parseNip71Video(event);
        if (video) {
          movieStore.addVideo(video);
          notifyUpdate();
        }
      },
      () => {
        // EOSE can arrive before all cache/relay sources have stabilized. Idle
        // and no-event timers own page settlement so a partial first burst
        // cannot permanently disable pagination.
      },
    );
    schedulePageSettle(initialLoad ? MOVIE_PAGE_INITIAL_SETTLE_TIMEOUT_MS : MOVIE_PAGE_EMPTY_SETTLE_TIMEOUT_MS);
  }

  function ensureVisibleVideos(): void {
    if (wantsLongFormSearch()) loadNextMoviePage();
  }

  function setShortsVisible(next: boolean): void {
    // At least one of Shorts / Long form must stay active.
    if (!next && !showLongForm) return;
    showShorts = next;
    ensureVisibleVideos();
  }

  function setLongFormVisible(next: boolean): void {
    if (!next && !showShorts) return;
    showLongForm = next;
    ensureVisibleVideos();
  }

  function setNsfwVisible(next: boolean): void {
    showNsfw = next;
    // Hiding NSFW can leave the grid short — top up so it can fill/scroll.
    if (!next) loadNextMoviePage();
  }

  function toggleHashtag(tag: string): void {
    activeHashtag = activeHashtag === tag ? null : tag;
    // A hashtag filter can leave the grid short — top up so it can fill/scroll.
    if (activeHashtag !== null) loadNextMoviePage();
  }

  function clearHashtagFilter(): void {
    activeHashtag = null;
  }

  function handleScroll(): void {
    if (hasVisibleVideoType() && isNearLoadBoundary()) loadNextMoviePage();
  }

  $effect(() => {
    const sentinel = loadMoreSentinel;
    const root = scrollContainer;
    const canLoadMore = hasMore;

    observer?.disconnect();
    observer = null;

    if (canLoadMore && sentinel && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) loadNextMoviePage();
        },
        { root: root ?? null, rootMargin: '1200px 0px' },
      );
      observer.observe(sentinel);
    }

    return () => {
      observer?.disconnect();
      observer = null;
    };
  });

  onMount(() => {
    movieStore.reset();
    movieStore.setLoading(false);
    hasMore = true;
    activeHashtag = null;
    showNsfw = false;
    oldestSeenCreatedAt = null;
    pageRequestId = 0;
    pendingPageRequest = false;
    lowVisiblePageStreak = 0;
    loadNextMoviePage();

    pollInterval = setInterval(notifyUpdate, 500);
  });

  onDestroy(() => {
    pageRequestId++;
    closePageSubscription();
    if (profileBatchTimer) clearTimeout(profileBatchTimer);
    for (const subscription of profileSubscriptions) subscription.close();
    profileSubscriptions.clear();
    for (const subscription of thumbnailPreloads.values()) subscription.close();
    thumbnailPreloads.clear();
    observer?.disconnect();
    if (pollInterval) clearInterval(pollInterval);
    void releaseCurrentRuntime();
  });
</script>

<div
  class="h-screen bg-bg-base overflow-auto"
  bind:this={scrollContainer}
  onscroll={handleScroll}
  data-movie-root
  data-movie-count={videos.length}
  data-movie-rendered-count={renderedVideos.length}
  data-movie-total-count={allVideos.length}
  data-movie-loading={loading}
  data-movie-loading-more={loadingMore}
  data-movie-has-more={hasMore}
  data-movie-page-requests={pageRequestId}
  data-movie-retained-limit={MOVIE_RETAINED_VIDEO_LIMIT}
  data-movie-rendered-limit={MOVIE_RENDERED_VIDEO_LIMIT}
>
  {#if loading && videos.length === 0}
    <div class="p-4 text-text-muted text-sm">Loading videos...</div>
  {:else if !loading && allVideos.length === 0}
    <div class="p-4 text-text-muted text-sm">No videos found</div>
  {:else}
    <header class="header-bar">
      <div class="header-info">
        <span class="video-count">
          {videos.length}
          {videos.length === 1 ? 'video' : 'videos'}
        </span>
        {#if topHashtags.length > 0}
          <span class="hashtags">
            {#each topHashtags as { tag } (tag)}
              <button
                type="button"
                class="hashtag"
                class:active={activeHashtag === tag}
                aria-pressed={activeHashtag === tag}
                onclick={() => { toggleHashtag(tag); }}
              >#{tag}</button>
            {/each}
          </span>
        {/if}
        {#if activeHashtag !== null}
          <button type="button" class="clear-filter" onclick={clearHashtagFilter}>
            Clear ✕
          </button>
        {/if}
      </div>
      <div class="header-toggles">
        <button
          type="button"
          class="filter-toggle"
          class:active={showShorts}
          aria-pressed={showShorts}
          disabled={showShorts && !showLongForm}
          onclick={() => { setShortsVisible(!showShorts); }}
        >
          Shorts
        </button>
        <button
          type="button"
          class="filter-toggle"
          class:active={showLongForm}
          aria-pressed={showLongForm}
          disabled={showLongForm && !showShorts}
          onclick={() => { setLongFormVisible(!showLongForm); }}
        >
          Long form
        </button>
        <button
          type="button"
          class="filter-toggle"
          class:active={showNsfw}
          aria-pressed={showNsfw}
          title="Show #nsfw videos"
          onclick={() => { setNsfwVisible(!showNsfw); }}
        >
          NSFW
        </button>
      </div>
    </header>
    {#if videos.length === 0 && !loading}
      <div class="p-4 text-text-muted text-sm">
        {#if activeHashtag !== null}
          No videos match #{activeHashtag} yet.
          <button type="button" class="inline-clear" onclick={clearHashtagFilter}>Clear filter</button>
        {:else}
          No videos match the active filters
        {/if}
      </div>
    {/if}
    <div class="movie-grid">
      {#each renderedVideos as video (video.id)}
        <VideoCard
          {video}
          profile={profiles.get(video.pubkey)}
          activeHashtag={activeHashtag}
          active={activeVideoId === video.id}
          playbackState={activeVideoId === video.id ? runtimeState : null}
          error={runtimeErrorVideoId === video.id}
          disabled={requestInFlight}
          onselect={() => { void selectVideo(video); }}
          onhashtag={toggleHashtag}
        />
      {/each}
    </div>
  {/if}

  {#if hasMore}
    <div bind:this={loadMoreSentinel} class="load-more-sentinel" aria-live="polite">
      {#if loadingMore}
        {wantsLongFormSearch() ? 'Searching for long form videos...' : 'Loading more videos...'}
      {/if}
    </div>
  {:else if allVideos.length > 0}
    <div class="load-more-sentinel text-text-muted">End of results</div>
  {/if}
</div>

<style>
  .header-bar {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 14px;
    background: color-mix(in srgb, var(--hg-bg-base, #050505) 88%, transparent);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid color-mix(in srgb, var(--hg-text-muted, #b8b1a4) 14%, transparent);
  }

  .header-info {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    overflow: hidden;
  }

  .video-count {
    flex: none;
    font-size: 12px;
    font-weight: 600;
    color: var(--hg-text-primary, #f2efe7);
  }

  .hashtags {
    display: flex;
    flex-wrap: nowrap;
    gap: 6px;
    overflow: hidden;
    min-width: 0;
  }

  .hashtag {
    flex: none;
    font: inherit;
    font-size: 11px;
    color: var(--hg-text-muted, #b8b1a4);
    white-space: nowrap;
    background: transparent;
    border: none;
    padding: 2px 4px;
    border-radius: 4px;
    cursor: pointer;
    transition: color 120ms ease, background 120ms ease;
  }

  .hashtag:hover {
    color: var(--hg-text-primary, #f2efe7);
    background: color-mix(in srgb, var(--hg-text-muted, #b8b1a4) 14%, transparent);
  }

  .hashtag.active {
    color: var(--hg-accent-primary, #5d5dff);
    background: color-mix(in srgb, var(--hg-accent-primary, #5d5dff) 18%, transparent);
  }

  .clear-filter {
    flex: none;
    font: inherit;
    font-size: 11px;
    white-space: nowrap;
    color: var(--hg-text-primary, #f2efe7);
    background: color-mix(in srgb, var(--hg-accent-primary, #5d5dff) 22%, transparent);
    border: 1px solid color-mix(in srgb, var(--hg-accent-primary, #5d5dff) 50%, transparent);
    border-radius: 999px;
    padding: 3px 10px;
    cursor: pointer;
  }

  .clear-filter:hover {
    background: color-mix(in srgb, var(--hg-accent-primary, #5d5dff) 34%, transparent);
  }

  .inline-clear {
    font: inherit;
    color: var(--hg-accent-primary, #5d5dff);
    background: none;
    border: none;
    padding: 0;
    margin-left: 4px;
    cursor: pointer;
    text-decoration: underline;
  }

  .header-toggles {
    flex: none;
    display: flex;
    gap: 6px;
  }

  .movie-grid {
    --movie-card-min: clamp(260px, 23vw, 360px);
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--movie-card-min)), 1fr));
    gap: 16px;
    padding: 14px;
  }

  .filter-toggle {
    border: 1px solid color-mix(in srgb, var(--hg-text-muted, #b8b1a4) 22%, transparent);
    border-radius: 999px;
    background: transparent;
    color: var(--hg-text-muted, #b8b1a4);
    font: inherit;
    font-size: 12px;
    padding: 4px 12px;
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  }

  .filter-toggle:hover {
    color: var(--hg-text-primary, #f2efe7);
    border-color: color-mix(in srgb, var(--hg-accent-primary, #5d5dff) 50%, transparent);
  }

  .filter-toggle.active {
    border-color: var(--hg-accent-primary, #5d5dff);
    color: var(--hg-text-primary, #f2efe7);
    background: color-mix(in srgb, var(--hg-accent-primary, #5d5dff) 22%, transparent);
  }

  /* The lone active toggle can't be turned off — show it as locked-on. */
  .filter-toggle:disabled {
    cursor: default;
  }

  .filter-toggle:disabled:hover {
    border-color: var(--hg-accent-primary, #5d5dff);
    color: var(--hg-text-primary, #f2efe7);
  }

  .load-more-sentinel {
    min-height: 72px;
    padding: 16px;
    text-align: center;
    color: var(--hg-text-muted, #b8b1a4);
    font-size: 12px;
  }
</style>
