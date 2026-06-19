<script lang="ts">
  import { nip19 } from 'nostr-tools';
  import { resourceImage, pubkeyReadableColor } from '@hyprgate/utils';
  import type { RuntimePlayerStatus } from '@hyprgate/utils';
  import type { VideoEntry } from '../lib/movie-store.js';
  import type { ProfileContent } from '../lib/profile-metadata.js';

  interface Props {
    video: VideoEntry;
    onselect: () => void;
    onhashtag?: (tag: string) => void;
    profile?: ProfileContent;
    activeHashtag?: string | null;
    active?: boolean;
    playbackState?: RuntimePlayerStatus | null;
    error?: boolean;
    disabled?: boolean;
  }

  let {
    video,
    onselect,
    onhashtag,
    profile,
    activeHashtag = null,
    active = false,
    playbackState = null,
    error = false,
    disabled = false,
  }: Props = $props();

  const MAX_CARD_TAGS = 4;
  const THUMBNAIL_LOAD_TIMEOUT_MS = 5_000;

  type ThumbnailLoadState = 'loading' | 'loaded' | 'empty';

  function formatDuration(seconds: number | null): string {
    if (seconds === null) return '';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  function isShortVideo(): boolean {
    return video.kind === 34236 || (video.duration !== null && video.duration <= 60);
  }

  function shortenPubkey(pubkey: string): string {
    try {
      return nip19.npubEncode(pubkey).slice(0, 10) + '…';
    } catch {
      return pubkey.slice(0, 8) + '…';
    }
  }

  let authorName = $derived(
    profile?.display_name?.trim() || profile?.name?.trim() || shortenPubkey(video.pubkey),
  );
  let avatarColor = $derived(pubkeyReadableColor(video.pubkey));
  let avatarInitial = $derived((authorName[0] ?? '?').toUpperCase());
  let cardTags = $derived(video.hashtags.slice(0, MAX_CARD_TAGS));
  let cardElement: HTMLDivElement | undefined = $state();
  let thumbnailVisible = $state(false);
  let thumbnailLoadState = $state<ThumbnailLoadState>('empty');
  let thumbnailTimeout: ReturnType<typeof setTimeout> | null = null;

  function clearThumbnailTimeout(): void {
    if (thumbnailTimeout === null) return;
    clearTimeout(thumbnailTimeout);
    thumbnailTimeout = null;
  }

  function handleThumbnailLoaded(): void {
    clearThumbnailTimeout();
    thumbnailLoadState = 'loaded';
  }

  function handleThumbnailError(): void {
    thumbnailLoadState = 'empty';
  }

  function thumbnailPlaceholderLabel(): string {
    return thumbnailLoadState === 'empty' ? 'No thumbnail' : 'Loading thumbnail';
  }

  $effect(() => {
    const source = video.thumbnail;
    const visible = thumbnailVisible;
    clearThumbnailTimeout();
    thumbnailLoadState = source ? 'loading' : 'empty';
    if (!source || !visible) return;

    thumbnailTimeout = setTimeout(() => {
      thumbnailTimeout = null;
      if (thumbnailLoadState !== 'loaded') thumbnailLoadState = 'empty';
    }, THUMBNAIL_LOAD_TIMEOUT_MS);

    return clearThumbnailTimeout;
  });

  $effect(() => {
    const source = video.thumbnail;
    const node = cardElement;
    thumbnailVisible = false;
    if (!source) return;
    if (!node || typeof IntersectionObserver === 'undefined') {
      thumbnailVisible = true;
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        thumbnailVisible = true;
        observer.disconnect();
      },
      { root: null, rootMargin: '700px 0px' },
    );
    observer.observe(node);

    return () => {
      observer.disconnect();
    };
  });
</script>

<div class="card group" class:active class:error bind:this={cardElement}>
  <button
    class="thumb"
    onclick={onselect}
    {disabled}
    aria-pressed={active}
    title={video.title || 'Untitled'}
  >
    {#if video.thumbnail && !thumbnailVisible}
      <div
        class="thumbnail-placeholder"
        data-video-thumbnail-placeholder
        data-thumbnail-state="loading"
        aria-label="Loading thumbnail"
      >
        <span>▶</span>
      </div>
    {:else if video.thumbnail}
      <img
        use:resourceImage={video.thumbnail}
        alt={video.title || 'Video thumbnail'}
        class="thumbnail-image"
        class:loaded={thumbnailLoadState === 'loaded'}
        loading="lazy"
        decoding="async"
        onload={handleThumbnailLoaded}
        onerror={handleThumbnailError}
        data-video-thumbnail
      />
      {#if thumbnailLoadState !== 'loaded'}
        <div
          class="thumbnail-placeholder"
          data-video-thumbnail-placeholder
          data-thumbnail-state={thumbnailLoadState}
          aria-label={thumbnailPlaceholderLabel()}
        >
          <span>▶</span>
        </div>
      {/if}
    {:else}
      <div
        class="thumbnail-placeholder"
        data-video-thumbnail-placeholder
        data-thumbnail-state="empty"
        aria-label="No thumbnail"
      >
        <span>▶</span>
      </div>
    {/if}

    {#if video.duration !== null}
      <div class="badge badge-duration">{formatDuration(video.duration)}</div>
    {/if}

    {#if isShortVideo()}
      <div class="badge badge-short">Short</div>
    {/if}

    <!-- Title bar: semi-transparent, revealed on hover/focus -->
    <div class="title-overlay">
      <span class="title-text">{video.title || 'Untitled'}</span>
    </div>

    {#if active}
      <div class="media-state" aria-label={playbackState ?? 'selected'}>
        {#if error}
          !
        {:else if playbackState === 'playing' || playbackState === 'loading'}
          II
        {:else}
          ▶
        {/if}
      </div>
    {/if}
  </button>

  <div class="meta">
    {#if profile?.picture}
      <img
        use:resourceImage={profile.picture}
        alt={authorName}
        class="avatar"
      />
    {:else}
      <span class="avatar avatar-fallback" style="background:{avatarColor}">{avatarInitial}</span>
    {/if}
    <span class="author-name">{authorName}</span>
    {#if video.client}
      <span class="client" title={'Published with ' + video.client}>{video.client}</span>
    {/if}
  </div>

  {#if cardTags.length > 0 && onhashtag}
    <div class="card-tags">
      {#each cardTags as tag (tag)}
        <button
          type="button"
          class="card-tag"
          class:active={activeHashtag === tag}
          aria-pressed={activeHashtag === tag}
          onclick={() => onhashtag?.(tag)}
        >#{tag}</button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .card {
    display: flex;
    flex-direction: column;
    width: 100%;
    text-align: left;
  }

  .thumb {
    position: relative;
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    background: var(--hg-bg-elevated, #1a1a1a);
    overflow: hidden;
    border: none;
    border-radius: 0;
    padding: 0;
    cursor: pointer;
    color: inherit;
  }

  .thumb[disabled] {
    cursor: default;
    opacity: 0.6;
  }

  .thumbnail-image {
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    transition: opacity 160ms ease;
  }

  .thumbnail-image.loaded {
    opacity: 1;
  }

  .thumbnail-placeholder {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--hg-text-dim, #6d6872);
    font-size: 30px;
    background:
      linear-gradient(
        135deg,
        color-mix(in srgb, var(--hg-bg-elevated, #1a1a1a) 96%, var(--hg-text-muted, #b8b1a4) 4%),
        color-mix(in srgb, var(--hg-bg-elevated, #1a1a1a) 84%, var(--hg-bg-base, #050505) 16%)
      );
    pointer-events: none;
  }

  .thumbnail-placeholder[data-thumbnail-state='loading']::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(
      100deg,
      transparent 0%,
      color-mix(in srgb, var(--hg-text-muted, #b8b1a4) 10%, transparent) 45%,
      transparent 80%
    );
    transform: translateX(-100%);
    animation: thumbnail-shimmer 1.25s ease-in-out infinite;
  }

  .thumbnail-placeholder[data-thumbnail-state='empty'] {
    color: color-mix(in srgb, var(--hg-text-dim, #6d6872) 70%, transparent);
    background: color-mix(in srgb, var(--hg-bg-elevated, #1a1a1a) 88%, var(--hg-bg-base, #050505) 12%);
  }

  .thumbnail-placeholder span {
    position: relative;
    z-index: 1;
  }

  @keyframes thumbnail-shimmer {
    to {
      transform: translateX(100%);
    }
  }

  .card.active .thumb {
    box-shadow: inset 0 0 0 2px var(--hg-accent-primary, #5d5dff);
  }

  .card.error .thumb {
    box-shadow: inset 0 0 0 2px var(--hg-accent-red, #ff6b6b);
  }

  .badge {
    position: absolute;
    font-size: 11px;
    line-height: 1;
    padding: 3px 5px;
    border-radius: 3px;
    font-weight: 600;
  }

  .badge-duration {
    bottom: 6px;
    right: 6px;
    background: color-mix(in srgb, var(--hg-bg-base, #050505) 82%, transparent);
    color: var(--hg-text-primary, #f2efe7);
  }

  .badge-short {
    top: 6px;
    left: 6px;
    background: color-mix(in srgb, var(--hg-accent-primary, #5d5dff) 85%, transparent);
    color: var(--hg-bg-base, #050505);
  }

  .title-overlay {
    position: absolute;
    inset-inline: 0;
    bottom: 0;
    padding: 16px 10px 8px;
    background: linear-gradient(
      to top,
      color-mix(in srgb, var(--hg-bg-base, #050505) 92%, transparent),
      transparent
    );
    opacity: 0;
    transform: translateY(4px);
    transition: opacity 140ms ease, transform 140ms ease;
    pointer-events: none;
  }

  .thumb:hover .title-overlay,
  .thumb:focus-visible .title-overlay {
    opacity: 1;
    transform: translateY(0);
  }

  .title-text {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.3;
    color: var(--hg-text-primary, #f2efe7);
    text-shadow: 0 1px 6px #000;
  }

  .media-state {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--hg-text-primary, #f2efe7);
    font-size: 28px;
    font-weight: 700;
    text-shadow: 0 2px 14px #000;
    background: color-mix(in srgb, var(--hg-bg-base, #050505) 22%, transparent);
    pointer-events: none;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 7px 8px 0;
    min-width: 0;
  }

  .avatar {
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    object-fit: cover;
  }

  .avatar-fallback {
    display: grid;
    place-items: center;
    font-size: 11px;
    font-weight: 700;
    color: var(--hg-bg-base, #050505);
  }

  .author-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    color: var(--hg-text-muted, #b8b1a4);
  }

  .client {
    flex: none;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 999px;
    color: var(--hg-text-muted, #b8b1a4);
    background: color-mix(in srgb, var(--hg-text-muted, #b8b1a4) 14%, transparent);
  }

  .card-tags {
    display: flex;
    flex-wrap: nowrap;
    gap: 4px;
    padding: 6px 8px 0;
    overflow: hidden;
    max-height: 26px;
  }

  .card-tag {
    flex: none;
    font: inherit;
    font-size: 10px;
    line-height: 1;
    white-space: nowrap;
    padding: 3px 7px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--hg-text-muted, #b8b1a4) 20%, transparent);
    background: transparent;
    color: var(--hg-text-muted, #b8b1a4);
    cursor: pointer;
    transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
  }

  .card-tag:hover {
    color: var(--hg-text-primary, #f2efe7);
    border-color: color-mix(in srgb, var(--hg-accent-primary, #5d5dff) 50%, transparent);
  }

  .card-tag.active {
    color: var(--hg-text-primary, #f2efe7);
    border-color: var(--hg-accent-primary, #5d5dff);
    background: color-mix(in srgb, var(--hg-accent-primary, #5d5dff) 22%, transparent);
  }
</style>
