import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent } from '@hyprgate/types';
import { outbox, relay } from '@napplet/sdk';
import { subscribeProfileMetadata } from './profile-metadata.js';

vi.mock('@napplet/sdk', () => ({
  relay: {
    subscribe: vi.fn(),
  },
  outbox: {
    subscribe: vi.fn(),
  },
}));

interface FakeOutboxSub {
  close: ReturnType<typeof vi.fn>;
  handlers: Record<string, ((...args: unknown[]) => void) | undefined>;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
}

function makeOutboxSub(): FakeOutboxSub {
  const sub: FakeOutboxSub = {
    close: vi.fn(),
    handlers: {},
    on(event, cb) {
      this.handlers[event] = cb;
    },
    emit(event, ...args) {
      this.handlers[event]?.(...args);
    },
  };
  return sub;
}

function installShell(supportsOutbox = true): void {
  (globalThis as unknown as { napplet: unknown }).napplet = {
    shell: {
      ready: vi.fn().mockResolvedValue({}),
      supports: vi.fn((domain: string) => (domain === 'outbox' ? supportsOutbox : false)),
    },
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeProfileEvent(pubkey: string, createdAt: number, content: unknown): NostrEvent {
  return {
    id: `${pubkey}-${createdAt}`,
    kind: 0,
    pubkey,
    created_at: createdAt,
    tags: [],
    content: typeof content === 'string' ? content : JSON.stringify(content),
    sig: 'sig',
  };
}

describe('subscribeProfileMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(relay.subscribe).mockReturnValue({ close: vi.fn() });
    vi.mocked(outbox.subscribe).mockReturnValue(
      makeOutboxSub() as unknown as ReturnType<typeof outbox.subscribe>,
    );
    installShell();
  });

  afterEach(() => {
    delete (globalThis as unknown as { napplet?: unknown }).napplet;
  });

  it('uses a live outbox subscription so late kind-0 metadata replaces npub fallbacks', async () => {
    const sub = makeOutboxSub();
    const relayClose = vi.fn();
    vi.mocked(outbox.subscribe).mockImplementation((filters, options) => {
      expect(filters).toEqual([{ kinds: [0], authors: ['pk1'], limit: 1 }]);
      expect(options).toEqual({ strategy: 'outbox', live: true });
      return sub as unknown as ReturnType<typeof outbox.subscribe>;
    });
    vi.mocked(relay.subscribe).mockImplementation((filters) => {
      expect(filters).toEqual([{ kinds: [0], authors: ['pk1'], limit: 1 }]);
      return { close: relayClose };
    });
    const received: Array<[string, unknown]> = [];
    const done = vi.fn();

    const handle = subscribeProfileMetadata(['pk1'], (pubkey, profile) => received.push([pubkey, profile]), done);
    await flush();

    expect(relay.subscribe).toHaveBeenCalledOnce();
    sub.emit('eose');
    expect(done).toHaveBeenCalledOnce();
    expect(sub.close).not.toHaveBeenCalled();

    sub.emit('event', makeProfileEvent('pk1', 100, {
      name: 'alice',
      display_name: 'Alice',
      picture: 'https://example.com/alice.png',
    }));

    expect(received).toEqual([['pk1', {
      name: 'alice',
      display_name: 'Alice',
      picture: 'https://example.com/alice.png',
    }]]);

    handle.close();
    expect(sub.close).toHaveBeenCalledOnce();
    expect(relayClose).toHaveBeenCalledOnce();
  });

  it('keeps the newest metadata event per pubkey and ignores malformed content', async () => {
    const sub = makeOutboxSub();
    vi.mocked(outbox.subscribe).mockImplementation(() => {
      return sub as unknown as ReturnType<typeof outbox.subscribe>;
    });
    const received: Array<[string, string | undefined]> = [];

    subscribeProfileMetadata(['pk1'], (pubkey, profile) => received.push([pubkey, profile.name]));
    await flush();

    sub.emit('event', makeProfileEvent('pk1', 200, { name: 'new' }));
    sub.emit('event', makeProfileEvent('pk1', 100, { name: 'old' }));
    sub.emit('event', makeProfileEvent('pk1', 300, '{malformed'));

    expect(received).toEqual([['pk1', 'new']]);
  });

  it('falls back to relay.subscribe when the shell does not support outbox', async () => {
    installShell(false);
    let onEvent: ((event: NostrEvent) => void) | undefined;
    const close = vi.fn();
    vi.mocked(relay.subscribe).mockImplementation((filters, eventCb) => {
      onEvent = eventCb as (event: NostrEvent) => void;
      expect(filters).toEqual([{ kinds: [0], authors: ['pk1'], limit: 1 }]);
      return { close };
    });
    const received: Array<[string, string | undefined]> = [];

    subscribeProfileMetadata(['pk1'], (pubkey, profile) => received.push([pubkey, profile.name]));
    await flush();

    expect(outbox.subscribe).not.toHaveBeenCalled();
    expect(relay.subscribe).toHaveBeenCalledOnce();
    onEvent?.(makeProfileEvent('pk1', 100, { name: 'fallback' }));
    expect(received).toEqual([['pk1', 'fallback']]);
  });

  it('honors close() called before the ready() gate resolves', async () => {
    const close = vi.fn();
    vi.mocked(relay.subscribe).mockReturnValue({ close });

    const handle = subscribeProfileMetadata(['pk1'], () => { /* no-op */ });
    handle.close();
    await flush();

    expect(outbox.subscribe).not.toHaveBeenCalled();
    expect(relay.subscribe).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('returns the NOOP subscription synchronously when there are no authors', () => {
    const done = vi.fn();
    const handle = subscribeProfileMetadata([], () => { /* no-op */ }, done);
    expect(done).toHaveBeenCalledOnce();
    expect(() => handle.close()).not.toThrow();
  });
});
