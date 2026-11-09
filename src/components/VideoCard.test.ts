import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Buffer } from 'node:buffer';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compile } from 'svelte/compiler';
import type { VideoEntry } from '../lib/movie-store.js';
import type { ProfileContent } from '../lib/profile-metadata.js';

const require = createRequire(import.meta.url);

function moduleUrl(specifier: string): string {
  return pathToFileURL(require.resolve(specifier)).href;
}

function svelteClientUrl(): string {
  return new URL('./src/index-client.js', moduleUrl('svelte/package.json')).href;
}

function dataModule(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}

function rewriteCompiledImports(code: string): string {
  const utilsUrl = dataModule(`
    export function resourceImage(node, url) {
      if (url) node.setAttribute('src', url);
      return {
        update(nextUrl) {
          if (nextUrl) node.setAttribute('src', nextUrl);
          else node.removeAttribute('src');
        },
        destroy() {}
      };
    }
    export function pubkeyReadableColor() {
      return '#445566';
    }
  `);
  return code
    .replace(
      "import 'svelte/internal/disclose-version';",
      `import ${JSON.stringify(moduleUrl('svelte/internal/disclose-version'))};`,
    )
    .replace(
      "from 'svelte/internal/client'",
      `from ${JSON.stringify(moduleUrl('svelte/internal/client'))}`,
    )
    .replace(
      /from '\.\.\/lib\/video-format\.js'/,
      `from ${JSON.stringify(formatModuleUrl())}`,
    )
    .replace(
      "from '@hyprgate/utils'",
      `from ${JSON.stringify(utilsUrl)}`,
    );
}

// Real npub encoding, but the module has to be inlined for the data: URL import.
function formatModuleUrl(): string {
  return dataModule(`
    export const formatAge = () => '2d ago';
    export const formatDuration = (seconds) => String(seconds);
    export const npubFor = (pubkey) => 'npub_' + pubkey;
    export const shortNpub = (pubkey) => 'npub_' + pubkey.slice(0, 4);
    export const playbackLabel = (state) => (state === 'error' ? "Can't play this one" : 'Now playing');
  `);
}

function compileComponentUrl(source: string, filename: string): string {
  const output = compile(source, { filename, generate: 'client', dev: true });
  return dataModule(rewriteCompiledImports(output.js.code));
}

const PUBKEY = 'b'.repeat(64);

interface HarnessOptions {
  title?: string;
  playbackState?: string | null;
}

async function loadVideoCardHarness(
  thumbnail: string | null = null,
  initialThumbnailVisible = false,
  options: HarnessOptions = {},
): Promise<unknown> {
  const cardSource = readFileSync('src/components/VideoCard.svelte', 'utf8');
  const videoCardUrl = compileComponentUrl(cardSource, 'VideoCard.svelte');

  const source = `
    <script>
      import VideoCard from '${videoCardUrl}';
      const video = {
        id: 'movie-1',
        title: ${JSON.stringify(options.title ?? 'Movie')},
        url: 'https://example.com/movie.mp4',
        thumbnail: ${JSON.stringify(thumbnail)},
        duration: 120,
        kind: 34235,
        pubkey: '${PUBKEY}',
        createdAt: 1700000000,
        client: null,
        hashtags: []
      };
      let profile = $state(undefined);
      let thumbnailVisible = $state(${JSON.stringify(initialThumbnailVisible)});
      export function setProfile(nextProfile) {
        profile = nextProfile;
      }
      export function setThumbnailVisible(nextVisible) {
        thumbnailVisible = nextVisible;
      }
    </script>

    <VideoCard
      {video}
      {profile}
      {thumbnailVisible}
      active={${options.playbackState !== undefined}}
      playbackState={${JSON.stringify(options.playbackState ?? null)}}
      onselect={() => {}}
      onauthor={(pubkey) => { globalThis.__openedAuthor = pubkey; }}
    />
  `;

  const output = compile(source, { filename: 'VideoCardHarness.svelte', generate: 'client', dev: true });
  return (await import(dataModule(rewriteCompiledImports(output.js.code)))).default;
}

describe('VideoCard profile rendering', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('updates the visible author name and avatar when profile metadata arrives', async () => {
    const { mount, unmount } = await import(svelteClientUrl()) as typeof import('svelte');
    const Harness = await loadVideoCardHarness() as Parameters<typeof mount>[0];
    const component = mount(Harness, { target: document.body }) as {
      setProfile(profile: ProfileContent): void;
    };

    expect(document.querySelector('.author-name')?.textContent?.trim()).not.toBe('Alice Movie');

    component.setProfile({
      name: 'alice',
      display_name: 'Alice Movie',
      picture: 'https://example.com/alice.png',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector('.author-name')?.textContent?.trim()).toBe('Alice Movie');
    const avatar = document.querySelector<HTMLImageElement>('img.avatar');
    expect(avatar?.getAttribute('src')).toBe('https://example.com/alice.png');

    unmount(component);
  });

  it('renders the resource thumbnail when the parent thumbnail window marks it visible', async () => {
    const { mount, unmount } = await import(svelteClientUrl()) as typeof import('svelte');
    const Harness = await loadVideoCardHarness('https://example.com/thumb.jpg', true) as Parameters<typeof mount>[0];
    const component = mount(Harness, { target: document.body });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const thumbnail = document.querySelector<HTMLImageElement>('[data-video-thumbnail]');
    expect(thumbnail?.getAttribute('src')).toBe('https://example.com/thumb.jpg');
    expect(thumbnail?.getAttribute('loading')).toBe('lazy');
    expect(thumbnail?.getAttribute('decoding')).toBe('async');
    expect(document.querySelector('[data-video-thumbnail-placeholder]')?.getAttribute('data-thumbnail-state')).toBe(
      'loading',
    );

    thumbnail?.dispatchEvent(new Event('load'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector('[data-video-thumbnail-placeholder]')).toBeNull();

    unmount(component);
  });

  it('falls back to an empty thumbnail after timeout without unmounting late hydration', async () => {
    vi.useFakeTimers();
    const { mount, unmount } = await import(svelteClientUrl()) as typeof import('svelte');
    const Harness = await loadVideoCardHarness('https://example.com/slow-thumb.jpg', true) as Parameters<typeof mount>[0];
    const component = mount(Harness, { target: document.body });
    await Promise.resolve();

    const thumbnail = document.querySelector<HTMLImageElement>('[data-video-thumbnail]');
    expect(thumbnail?.getAttribute('src')).toBe('https://example.com/slow-thumb.jpg');
    expect(document.querySelector('[data-video-thumbnail-placeholder]')?.getAttribute('data-thumbnail-state')).toBe(
      'loading',
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();

    const emptyPlaceholder = document.querySelector('[data-video-thumbnail-placeholder]');
    expect(emptyPlaceholder?.getAttribute('data-thumbnail-state')).toBe('empty');
    expect(thumbnail?.getAttribute('src')).toBe('https://example.com/slow-thumb.jpg');

    thumbnail?.dispatchEvent(new Event('load'));
    await Promise.resolve();

    expect(document.querySelector('[data-video-thumbnail-placeholder]')).toBeNull();
    expect(thumbnail?.classList.contains('loaded')).toBe(true);

    unmount(component);
  });

  it('mounts the resource thumbnail only after the parent thumbnail window includes the card', async () => {
    const { mount, unmount } = await import(svelteClientUrl()) as typeof import('svelte');
    const Harness = await loadVideoCardHarness('https://example.com/thumb.jpg') as Parameters<typeof mount>[0];
    const component = mount(Harness, { target: document.body }) as {
      setThumbnailVisible(nextVisible: boolean): void;
    };
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector('[data-video-thumbnail]')).toBeNull();
    expect(document.querySelector('[data-video-thumbnail-placeholder]')?.getAttribute('data-thumbnail-state')).toBe(
      'loading',
    );

    component.setThumbnailVisible(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const thumbnail = document.querySelector<HTMLImageElement>('[data-video-thumbnail]');
    expect(thumbnail?.getAttribute('src')).toBe('https://example.com/thumb.jpg');

    unmount(component);
  });

  it('shows the title on the card without needing a hover', async () => {
    const { mount, unmount } = await import(svelteClientUrl()) as typeof import('svelte');
    const Harness = await loadVideoCardHarness(null, false, { title: 'Harbour, 5am' }) as Parameters<typeof mount>[0];
    const component = mount(Harness, { target: document.body });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector('.video-title')?.textContent).toBe('Harbour, 5am');
    expect(document.querySelector('.thumb')?.getAttribute('aria-label')).toBe('Play Harbour, 5am');

    unmount(component);
  });

  it('falls back to a dim label when an event has no title', async () => {
    const { mount, unmount } = await import(svelteClientUrl()) as typeof import('svelte');
    const Harness = await loadVideoCardHarness(null, false, { title: '' }) as Parameters<typeof mount>[0];
    const component = mount(Harness, { target: document.body });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const title = document.querySelector('.video-title');
    expect(title?.textContent).toBe('Untitled video');
    expect(title?.classList.contains('untitled')).toBe(true);

    unmount(component);
  });

  it('asks for the author profile when the name is clicked, with or without metadata', async () => {
    const { mount, unmount } = await import(svelteClientUrl()) as typeof import('svelte');
    const Harness = await loadVideoCardHarness() as Parameters<typeof mount>[0];
    const component = mount(Harness, { target: document.body }) as { setProfile(profile: ProfileContent): void };
    await new Promise((resolve) => setTimeout(resolve, 0));
    const opened = () => (globalThis as { __openedAuthor?: string }).__openedAuthor;

    expect(document.querySelector('.author-name')?.textContent?.trim()).toBe('npub_bbbb');
    document.querySelector<HTMLButtonElement>('.author')?.click();
    expect(opened()).toBe(PUBKEY);

    (globalThis as { __openedAuthor?: string }).__openedAuthor = undefined;
    component.setProfile({ display_name: 'Alice Movie' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('.author-name')?.textContent?.trim()).toBe('Alice Movie');
    document.querySelector<HTMLButtonElement>('.author')?.click();
    expect(opened()).toBe(PUBKEY);

    unmount(component);
  });

  it('says so when the player reports it could not play the video', async () => {
    const { mount, unmount } = await import(svelteClientUrl()) as typeof import('svelte');
    const Harness = await loadVideoCardHarness(null, false, { playbackState: 'error' }) as Parameters<typeof mount>[0];
    const component = mount(Harness, { target: document.body });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector('.state-pill')?.textContent).toBe("Can't play this one");
    expect(document.querySelector('.card')?.classList.contains('error')).toBe(true);

    unmount(component);
  });
});
