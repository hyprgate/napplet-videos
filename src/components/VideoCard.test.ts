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
  const nostrToolsUrl = dataModule(`
    export const nip19 = {
      npubEncode(pubkey) {
        return 'npub_' + String(pubkey);
      }
    };
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
      "from 'nostr-tools'",
      `from ${JSON.stringify(nostrToolsUrl)}`,
    )
    .replace(
      "from '@hyprgate/utils'",
      `from ${JSON.stringify(utilsUrl)}`,
    );
}

function compileComponentUrl(source: string, filename: string): string {
  const output = compile(source, { filename, generate: 'client', dev: true });
  return dataModule(rewriteCompiledImports(output.js.code));
}

const originalIntersectionObserver = globalThis.IntersectionObserver;

async function loadVideoCardHarness(thumbnail: string | null = null): Promise<unknown> {
  const cardSource = readFileSync('src/components/VideoCard.svelte', 'utf8');
  const videoCardUrl = compileComponentUrl(cardSource, 'VideoCard.svelte');

  const source = `
    <script>
      import VideoCard from '${videoCardUrl}';
      const video = {
        id: 'movie-1',
        title: 'Movie',
        url: 'https://example.com/movie.mp4',
        thumbnail: ${JSON.stringify(thumbnail)},
        duration: 120,
        kind: 34235,
        pubkey: '${'b'.repeat(64)}',
        createdAt: 1700000000,
        client: null,
        hashtags: []
      };
      let profile = $state(undefined);
      export function setProfile(nextProfile) {
        profile = nextProfile;
      }
    </script>

    <VideoCard {video} {profile} onselect={() => {}} />
  `;

  const output = compile(source, { filename: 'VideoCardHarness.svelte', generate: 'client', dev: true });
  return (await import(dataModule(rewriteCompiledImports(output.js.code)))).default;
}

describe('VideoCard profile rendering', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    globalThis.IntersectionObserver = originalIntersectionObserver;
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
    expect(avatar?.alt).toBe('Alice Movie');
    expect(avatar?.getAttribute('src')).toBe('https://example.com/alice.png');

    unmount(component);
  });

  it('falls back to immediate thumbnail rendering when IntersectionObserver is unavailable', async () => {
    globalThis.IntersectionObserver = undefined as unknown as typeof IntersectionObserver;
    const { mount, unmount } = await import(svelteClientUrl()) as typeof import('svelte');
    const Harness = await loadVideoCardHarness('https://example.com/thumb.jpg') as Parameters<typeof mount>[0];
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
    globalThis.IntersectionObserver = undefined as unknown as typeof IntersectionObserver;
    const { mount, unmount } = await import(svelteClientUrl()) as typeof import('svelte');
    const Harness = await loadVideoCardHarness('https://example.com/slow-thumb.jpg') as Parameters<typeof mount>[0];
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

  it('mounts the resource thumbnail only after the card approaches the viewport', async () => {
    let observerCallback: IntersectionObserverCallback | undefined;
    class MockIntersectionObserver implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = '0px';
      readonly thresholds = [];
      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback;
      }
      disconnect(): void {}
      observe(): void {}
      takeRecords(): IntersectionObserverEntry[] { return []; }
      unobserve(): void {}
    }
    globalThis.IntersectionObserver = MockIntersectionObserver as typeof IntersectionObserver;
    const { mount, unmount } = await import(svelteClientUrl()) as typeof import('svelte');
    const Harness = await loadVideoCardHarness('https://example.com/thumb.jpg') as Parameters<typeof mount>[0];
    const component = mount(Harness, { target: document.body });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector('[data-video-thumbnail]')).toBeNull();
    expect(document.querySelector('[data-video-thumbnail-placeholder]')?.getAttribute('data-thumbnail-state')).toBe(
      'loading',
    );

    observerCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const thumbnail = document.querySelector<HTMLImageElement>('[data-video-thumbnail]');
    expect(thumbnail?.getAttribute('src')).toBe('https://example.com/thumb.jpg');

    unmount(component);
  });
});
