<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    controlRuntimePlayback,
    createProfileIntentRequest,
    invokeNappletIntent,
    releaseRuntimePlayback,
    requestRuntimePlayback,
    subscribeRuntimePlayback,
    type RuntimePlayerStatus,
    type RuntimePlayerSubscription,
  } from '@hyprgate/utils';
  import {
    buildMoviePageFilter,
    filterVisibleVideos,
    getVisiblePagingDecision,
    MOVIE_PAGE_LIMIT,
    MOVIE_RENDERED_VIDEO_LIMIT,
    MOVIE_RETAINED_VIDEO_LIMIT,
    MOVIE_VISIBLE_TARGET_MAX,
    movieStore,
    parseNip71Video,
    popularHashtags,
    videoAddress,
  } from './lib/movie-store.js';
  import {
    getNextMoviePageRequest,
    isMoviePageExhausted,
    MOVIE_PAGE_EMPTY_SETTLE_TIMEOUT_MS,
    MOVIE_PAGE_EMPTY_RETRY_LIMIT,
    MOVIE_PAGE_IDLE_SETTLE_MS,
    MOVIE_PAGE_INITIAL_SETTLE_TIMEOUT_MS,
    shouldQueueMoviePageRequest,
  } from './lib/movie-pagination.js';
  import { buildMoviePlaybackRequest } from './lib/movie-playback.js';
  import { playbackNeverStarted } from './lib/video-format.js';
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
  let lengthFilter = $derived<'all' | 'short' | 'long'>(
    showShorts && showLongForm ? 'all' : showShorts ? 'short' : 'long',
  );

  // Author profiles (kind 0), keyed by pubkey. Reassigned to trigger reactivity.
  const PROFILE_METADATA_BATCH_MS = 80;
  const THUMBNAIL_WINDOW_OVERSCAN_ROWS = 2;
  const THUMBNAIL_WINDOW_INITIAL_COUNT = 18;
  let profiles = $state<Map<string, ProfileContent>>(new Map());
  const profileSubscriptions = new Set<Subscription>();
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

  $effect(() => {
    // Re-subscribe whenever new authors appear in the loaded set.
    void allVideos;
    syncProfileSubscription();
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
  let thumbnailWindowStart = $state(0);
  let thumbnailWindowEnd = $state(THUMBNAIL_WINDOW_INITIAL_COUNT);
  let oldestSeenCreatedAt: number | null = null;
  let pageRequestId = $state(0);
  let pendingPageRequest = false;
  let lowVisiblePageStreak = 0;
  let emptyPageRetryStreak = 0;
  let pageSettleTimer: ReturnType<typeof setTimeout> | null = null;

  async function toggleActiveVideoPlayback(): Promise<void> {
    if (!runtimeSessionId) return;
    runtimeErrorVideoId = null;
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
    const address = videoAddress(video);
    if (activeVideoId === address && runtimeSessionId) {
      await toggleActiveVideoPlayback();
      return;
    }

    requestInFlight = true;
    runtimeErrorVideoId = null;
    activeVideoId = address;
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
        if (playbackNeverStarted(runtimeState, state?.state ?? null) && activeVideoId) {
          runtimeErrorVideoId = activeVideoId;
        }
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
      runtimeErrorVideoId = address;
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

      const pageExhausted = isMoviePageExhausted({
        pageEventCount: effectivePageEventCount,
        oldestSeenCreatedAt: settledOldestSeenCreatedAt,
        cursorBefore,
        loadedVideoCount,
        pageLimit: MOVIE_PAGE_LIMIT,
      });
      const shouldRetryEmptyPage = pageExhausted
        && cursorBefore !== null
        && pageEventCount === 0
        && loadedVideoCount > 0
        && emptyPageRetryStreak < MOVIE_PAGE_EMPTY_RETRY_LIMIT;
      if (shouldRetryEmptyPage) {
        emptyPageRetryStreak++;
      } else if (pageExhausted) {
        hasMore = false;
      } else {
        emptyPageRetryStreak = 0;
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

      if (hasMore && (shouldFollowQueuedBoundary || shouldRetryEmptyPage || pagingDecision.continuePaging || shouldTopUpGrid)) {
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

  function setLengthFilter(next: 'all' | 'short' | 'long'): void {
    showShorts = next !== 'long';
    showLongForm = next !== 'short';
    ensureVisibleVideos();
  }

  function openAuthor(pubkey: string): void {
    const request = createProfileIntentRequest({ pubkey });
    if (!request) return;
    void invokeNappletIntent(request).catch((error) => {
      console.warn('[movie] profile open failed', error);
    });
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
    updateThumbnailWindow();
    if (hasVisibleVideoType() && isNearLoadBoundary()) loadNextMoviePage();
  }

  function updateThumbnailWindow(): void {
    const root = scrollContainer;
    if (!root) return;

    const grid = root.querySelector<HTMLElement>('.movie-grid');
    const firstCard = grid?.querySelector<HTMLElement>('.card');
    if (!grid || !firstCard) {
      thumbnailWindowStart = 0;
      thumbnailWindowEnd = Math.min(renderedVideos.length, THUMBNAIL_WINDOW_INITIAL_COUNT);
      return;
    }

    const columns = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length);
    const rowGap = Number.parseFloat(getComputedStyle(grid).rowGap || '0') || 0;
    const gridTop = grid.offsetTop;
    const rowHeight = Math.max(1, firstCard.getBoundingClientRect().height + rowGap);
    const firstVisibleRow = Math.max(0, Math.floor((root.scrollTop - gridTop) / rowHeight) - THUMBNAIL_WINDOW_OVERSCAN_ROWS);
    const visibleRows = Math.ceil(root.clientHeight / rowHeight) + THUMBNAIL_WINDOW_OVERSCAN_ROWS * 2;
    const nextStart = Math.max(0, firstVisibleRow * columns);
    const nextEnd = Math.min(renderedVideos.length, (firstVisibleRow + visibleRows) * columns);

    thumbnailWindowStart = nextStart;
    thumbnailWindowEnd = Math.max(nextEnd, Math.min(renderedVideos.length, THUMBNAIL_WINDOW_INITIAL_COUNT));
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

  $effect(() => {
    const renderedCount = renderedVideos.length;
    void renderedCount;
    window.setTimeout(updateThumbnailWindow, 0);
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
    emptyPageRetryStreak = 0;
    loadNextMoviePage();

    pollInterval = setInterval(notifyUpdate, 500);
  });

  onDestroy(() => {
    pageRequestId++;
    closePageSubscription();
    if (profileBatchTimer) clearTimeout(profileBatchTimer);
    for (const subscription of profileSubscriptions) subscription.close();
    profileSubscriptions.clear();
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
  data-movie-thumbnail-window-start={thumbnailWindowStart}
  data-movie-thumbnail-window-end={thumbnailWindowEnd}
>
  {#if loading && allVideos.length === 0}
    <div class="movie-grid" aria-busy="true" aria-label="Loading videos" data-movie-skeleton>
      {#each { length: 6 } as _}
        <div class="skeleton-card" aria-hidden="true">
          <div class="skeleton-thumb"></div>
          <div class="skeleton-line wide"></div>
          <div class="skeleton-line"></div>
        </div>
      {/each}
    </div>
  {:else if !loading && allVideos.length === 0}
    <div class="empty-state" data-movie-empty>
      <p class="empty-title">No videos yet</p>
      <p class="empty-copy">Your relays didn't return any videos. New ones will show up here as they arrive.</p>
    </div>
  {:else}
    <header class="header-bar">
      <div class="header-info">
        <span class="video-count">
          {#if videos.length === allVideos.length}
            {videos.length} {videos.length === 1 ? 'video' : 'videos'}
          {:else}
            {videos.length} of {allVideos.length} videos
          {/if}
        </span>
        {#if topHashtags.length > 0}
          <div class="hashtags" role="group" aria-label="Filter by topic">
            {#each topHashtags as { tag } (tag)}
              <button
                type="button"
                class="hashtag"
                class:active={activeHashtag === tag}
                aria-pressed={activeHashtag === tag}
                onclick={() => { toggleHashtag(tag); }}
              >#{tag}</button>
            {/each}
          </div>
        {/if}
        {#if activeHashtag !== null}
          <button type="button" class="clear-filter" onclick={clearHashtagFilter}>
            Clear topic
          </button>
        {/if}
      </div>
      <div class="header-toggles">
        <div class="segmented" role="group" aria-label="Video length" data-video-length={lengthFilter}>
          {#each [['all', 'All'], ['short', 'Shorts'], ['long', 'Long form']] as const as [value, label] (value)}
            <button
              type="button"
              class="segment"
              class:active={lengthFilter === value}
              aria-pressed={lengthFilter === value}
              onclick={() => { setLengthFilter(value); }}
            >{label}</button>
          {/each}
        </div>
        <button
          type="button"
          class="nsfw-toggle"
          class:active={showNsfw}
          aria-pressed={showNsfw}
          aria-label="Show NSFW videos"
          title={showNsfw ? '#nsfw videos are showing' : '#nsfw videos are hidden'}
          onclick={() => { setNsfwVisible(!showNsfw); }}
        >
          NSFW {showNsfw ? 'on' : 'off'}
        </button>
      </div>
    </header>
    {#if videos.length === 0 && !loading}
      <div class="empty-state" data-movie-empty>
        <p class="empty-title">
          {#if activeHashtag !== null}
            No {lengthFilter === 'short' ? 'shorts' : lengthFilter === 'long' ? 'long form videos' : 'videos'} tagged #{activeHashtag}
          {:else}
            No {lengthFilter === 'short' ? 'shorts' : lengthFilter === 'long' ? 'long form videos' : 'videos'} to show
          {/if}
        </p>
        <div class="empty-actions">
          {#if lengthFilter !== 'all'}
            <button type="button" class="empty-action" onclick={() => { setLengthFilter('all'); }}>Show all lengths</button>
          {/if}
          {#if activeHashtag !== null}
            <button type="button" class="empty-action" onclick={clearHashtagFilter}>Clear #{activeHashtag}</button>
          {/if}
        </div>
      </div>
    {/if}
    <div class="movie-grid">
      {#each renderedVideos as video, index (videoAddress(video))}
        {@const address = videoAddress(video)}
        <VideoCard
          {video}
          profile={profiles.get(video.pubkey)}
          activeHashtag={activeHashtag}
          active={activeVideoId === address}
          playbackState={activeVideoId === address ? runtimeState : null}
          error={runtimeErrorVideoId === address}
          disabled={requestInFlight}
          thumbnailVisible={index >= thumbnailWindowStart && index < thumbnailWindowEnd}
          onselect={() => { void selectVideo(video); }}
          onhashtag={toggleHashtag}
          onauthor={openAuthor}
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
  {:else if videos.length > 0}
    <div class="load-more-sentinel end-of-results">That's everything we found</div>
  {/if}
</div>

<style>
  .header-bar {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 12px;
    padding: 10px 14px;
    background: color-mix(in srgb, var(--hg-bg-base, #050505) 88%, transparent);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid color-mix(in srgb, var(--hg-text-muted, #b8b1a4) 14%, transparent);
  }

  .header-info {
    display: flex;
    flex: 1 1 240px;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .video-count {
    flex: none;
    font-size: 12px;
    font-weight: 600;
    color: var(--hg-text-primary, #f2efe7);
  }

  /* Scrolls rather than clips, so every topic stays reachable in a narrow window. */
  .hashtags {
    display: flex;
    flex-wrap: nowrap;
    gap: 4px;
    overflow-x: auto;
    scrollbar-width: none;
    min-width: 0;
    padding: 2px;
  }

  .hashtag {
    flex: none;
    font: inherit;
    font-size: 11px;
    color: var(--hg-text-muted, #b8b1a4);
    white-space: nowrap;
    background: transparent;
    border: none;
    padding: 3px 6px;
    border-radius: 4px;
    cursor: pointer;
    transition: color 120ms ease, background 120ms ease;
  }

  .hashtag:hover {
    color: var(--hg-text-primary, #f2efe7);
    background: color-mix(in srgb, var(--hg-text-muted, #b8b1a4) 14%, transparent);
  }

  .hashtag.active {
    color: var(--hg-text-primary, #f2efe7);
    background: color-mix(in srgb, var(--hg-accent-primary, #5d5dff) 28%, transparent);
  }

  .clear-filter {
    flex: none;
    font: inherit;
    font-size: 11px;
    white-space: nowrap;
    color: var(--hg-text-muted, #b8b1a4);
    background: none;
    border: none;
    padding: 3px 4px;
    text-decoration: underline;
    cursor: pointer;
  }

  .clear-filter:hover {
    color: var(--hg-text-primary, #f2efe7);
  }

  .header-toggles {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .segmented {
    display: inline-flex;
    padding: 2px;
    gap: 2px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--hg-text-muted, #b8b1a4) 12%, transparent);
  }

  .segment {
    font: inherit;
    font-size: 12px;
    padding: 3px 10px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--hg-text-muted, #b8b1a4);
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
  }

  .segment:hover {
    color: var(--hg-text-primary, #f2efe7);
  }

  .segment.active {
    color: var(--hg-text-primary, #f2efe7);
    background: color-mix(in srgb, var(--hg-accent-primary, #5d5dff) 38%, transparent);
    font-weight: 600;
  }

  .nsfw-toggle {
    font: inherit;
    font-size: 11px;
    padding: 4px 8px;
    border: 1px solid color-mix(in srgb, var(--hg-text-muted, #b8b1a4) 22%, transparent);
    border-radius: 6px;
    background: transparent;
    color: var(--hg-text-muted, #b8b1a4);
    cursor: pointer;
    white-space: nowrap;
  }

  .nsfw-toggle:hover {
    color: var(--hg-text-primary, #f2efe7);
  }

  .nsfw-toggle.active {
    color: var(--hg-text-primary, #f2efe7);
    border-color: var(--hg-accent-primary, #5d5dff);
  }

  .hashtag:focus-visible,
  .clear-filter:focus-visible,
  .segment:focus-visible,
  .nsfw-toggle:focus-visible,
  .empty-action:focus-visible {
    outline: 2px solid var(--hg-accent-primary, #5d5dff);
    outline-offset: 1px;
  }

  .movie-grid {
    --movie-card-min: clamp(320px, max(27vw, 31vh), 640px);
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--movie-card-min)), 1fr));
    gap: 20px 16px;
    padding: 14px;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 72px 24px;
    text-align: center;
  }

  .empty-title {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--hg-text-primary, #f2efe7);
  }

  .empty-copy {
    margin: 0;
    max-width: 44ch;
    font-size: 13px;
    color: var(--hg-text-muted, #b8b1a4);
  }

  .empty-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
  }

  .empty-action {
    font: inherit;
    font-size: 12px;
    padding: 5px 12px;
    border: 1px solid color-mix(in srgb, var(--hg-text-muted, #b8b1a4) 30%, transparent);
    border-radius: 6px;
    background: transparent;
    color: var(--hg-text-primary, #f2efe7);
    cursor: pointer;
  }

  .empty-action:hover {
    border-color: var(--hg-accent-primary, #5d5dff);
  }

  .skeleton-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .skeleton-thumb,
  .skeleton-line {
    background: color-mix(in srgb, var(--hg-text-muted, #b8b1a4) 12%, transparent);
    animation: skeleton-pulse 1.4s ease-in-out infinite;
  }

  .skeleton-thumb {
    aspect-ratio: 16 / 9;
  }

  .skeleton-line {
    height: 10px;
    width: 40%;
    margin-inline: 8px;
    border-radius: 3px;
  }

  .skeleton-line.wide {
    width: 70%;
  }

  @keyframes skeleton-pulse {
    50% {
      opacity: 0.45;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .skeleton-thumb,
    .skeleton-line {
      animation: none;
    }
  }

  .load-more-sentinel {
    min-height: 72px;
    padding: 16px;
    text-align: center;
    color: var(--hg-text-muted, #b8b1a4);
    font-size: 12px;
  }

  .end-of-results {
    min-height: 0;
    opacity: 0.7;
  }
</style>
