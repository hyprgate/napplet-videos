<script lang="ts">
  import { resourceImage, pubkeyReadableColor } from '@hyprgate/utils';
  import type { RuntimePlayerStatus } from '@hyprgate/utils';
  import type { VideoEntry } from '../lib/movie-store.js';
  import type { ProfileContent } from '../lib/profile-metadata.js';
  import { formatAge, formatDuration, npubFor, playbackLabel, shortNpub } from '../lib/video-format.js';

  interface Props {
    video: VideoEntry;
    onselect: () => void;
    onhashtag?: (tag: string) => void;
    onauthor?: (pubkey: string) => void;
    profile?: ProfileContent;
    activeHashtag?: string | null;
    active?: boolean;
    playbackState?: RuntimePlayerStatus | null;
    error?: boolean;
    disabled?: boolean;
    thumbnailVisible?: boolean;
  }

  let {
    video,
    onselect,
    onhashtag,
    onauthor,
    profile,
    activeHashtag = null,
    active = false,
    playbackState = null,
    error = false,
    disabled = false,
    thumbnailVisible = false,
  }: Props = $props();

  const MAX_CARD_TAGS = 4;
  const THUMBNAIL_LOAD_TIMEOUT_MS = 5_000;

  type ThumbnailLoadState = 'loading' | 'loaded' | 'empty';

  function isShortVideo(): boolean {
    return video.kind === 34236 || (video.duration !== null && video.duration <= 60);
  }

  let authorName = $derived(
    profile?.display_name?.trim() || profile?.name?.trim() || shortNpub(video.pubkey),
  );
  let authorHasName = $derived(Boolean(profile?.display_name?.trim() || profile?.name?.trim()));
  let title = $derived(video.title.trim() || 'Untitled video');
  let hasError = $derived(error || playbackState === 'error');
  let stateLabel = $derived(playbackLabel(playbackState, error));
  let avatarColor = $derived(pubkeyReadableColor(video.pubkey));
  let avatarInitial = $derived((authorName[0] ?? '?').toUpperCase());
  let cardTags = $derived(video.hashtags.slice(0, MAX_CARD_TAGS));
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
</script>

<div class="card group" class:active class:error={hasError}>
  <button
    class="thumb"
    onclick={onselect}
    {disabled}
    aria-pressed={active}
    aria-label={`Play ${title}`}
    title={title}
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
        alt=""
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

    {#if active}
      <div class="media-state" data-playback-state={playbackState ?? 'selected'}>
        <span class="state-pill">{stateLabel}</span>
      </div>
    {/if}
  </button>

  <h3 class="video-title" class:untitled={!video.title.trim()} title={title}>{title}</h3>

  <div class="meta">
    <button
      type="button"
      class="author"
      title={authorHasName ? npubFor(video.pubkey) : `Open profile for ${npubFor(video.pubkey)}`}
      onclick={() => onauthor?.(video.pubkey)}
    >
      <span class="avatar-shell">
        <span class="avatar avatar-fallback" style="background:{avatarColor}">{avatarInitial}</span>
        {#if profile?.picture}
          <img
            use:resourceImage={profile.picture}
            alt=""
            class="avatar"
          />
        {/if}
      </span>
      <span class="author-name">{authorName}</span>
    </button>
    <span class="age">{formatAge(video.createdAt)}</span>
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

  .thumb:focus-visible {
    outline: 2px solid var(--hg-accent-primary, #5d5dff);
    outline-offset: 2px;
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

  /* An outline, because the thumbnail and its placeholder would cover an inset shadow. */
  .card.active .thumb {
    outline: 2px solid var(--hg-accent-primary, #5d5dff);
    outline-offset: 2px;
  }

  .card.error .thumb {
    outline-color: var(--hg-accent-red, #ff6b6b);
  }

  .card.error .state-pill {
    color: var(--hg-accent-red, #ff6b6b);
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

  .media-state {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: flex-end;
    padding: 6px;
    background: color-mix(in srgb, var(--hg-bg-base, #050505) 22%, transparent);
    pointer-events: none;
  }

  .state-pill {
    font-size: 11px;
    font-weight: 600;
    line-height: 1;
    padding: 4px 6px;
    border-radius: 3px;
    color: var(--hg-text-primary, #f2efe7);
    background: color-mix(in srgb, var(--hg-bg-base, #050505) 82%, transparent);
  }

  .video-title {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    margin: 8px 8px 0;
    font-family: var(--hg-font-body, inherit);
    font-size: 13px;
    font-weight: 600;
    line-height: 1.3;
    color: var(--hg-text-primary, #f2efe7);
  }

  .video-title.untitled {
    font-weight: 400;
    font-style: italic;
    color: var(--hg-text-muted, #b8b1a4);
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 8px 0;
    min-width: 0;
  }

  .author {
    display: inline-flex;
    flex: 0 1 auto;
    align-items: center;
    gap: 7px;
    min-width: 0;
    padding: 0;
    font: inherit;
    color: var(--hg-text-muted, #b8b1a4);
    background: none;
    border: none;
    cursor: pointer;
  }

  .author:hover .author-name {
    color: var(--hg-text-primary, #f2efe7);
    text-decoration: underline;
  }

  .author:focus-visible,
  .card-tag:focus-visible {
    outline: 2px solid var(--hg-accent-primary, #5d5dff);
    outline-offset: 2px;
    border-radius: 3px;
  }

  .age {
    flex: none;
    font-size: 11px;
    color: var(--hg-text-muted, #b8b1a4);
    opacity: 0.75;
  }

  .avatar {
    grid-area: 1 / 1;
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    object-fit: cover;
  }

  .avatar-shell {
    display: grid;
    flex: none;
    width: 22px;
    height: 22px;
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
    color: inherit;
  }

  .client {
    flex: none;
    margin-left: auto;
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
