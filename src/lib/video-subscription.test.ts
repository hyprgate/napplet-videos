import { describe, expect, it, vi } from 'vitest';
import { relay } from '@napplet/sdk';
import type { NostrEvent } from '@hyprgate/types';
import { subscribeVideoPage, VIDEO_RELAY_HINTS } from './video-subscription.js';

vi.mock('@napplet/sdk', () => ({
  relay: {
    subscribe: vi.fn(),
  },
}));

function makeEvent(id: string): NostrEvent {
  return {
    id,
    kind: 34236,
    pubkey: 'pk1',
    created_at: 1_700_000_000,
    tags: [['d', id], ['imeta', 'url https://example.com/video.mp4']],
    content: '',
    sig: 'sig',
  };
}

describe('subscribeVideoPage', () => {
  it('targets video-capable relays instead of relying on the generic relay tier', () => {
    vi.mocked(relay.subscribe).mockReturnValue({ close: vi.fn() });

    subscribeVideoPage({ kinds: [34235, 34236], limit: 100 }, () => { /* no-op */ }, () => { /* no-op */ });

    expect(VIDEO_RELAY_HINTS).toContain('wss://relay.divine.video');
    expect(relay.subscribe).toHaveBeenCalledTimes(VIDEO_RELAY_HINTS.length);
    expect(vi.mocked(relay.subscribe).mock.calls.map((call) => call[3])).toEqual(
      VIDEO_RELAY_HINTS.map((relayUrl) => ({ relay: relayUrl })),
    );
  });

  it('dedupes events delivered by multiple relays and closes every relay leg', () => {
    const closes = [vi.fn(), vi.fn()];
    const eventCallbacks: Array<(result: { event: NostrEvent }) => void> = [];
    vi.mocked(relay.subscribe).mockImplementation((_filter, onEvent) => {
      eventCallbacks.push(onEvent as (result: { event: NostrEvent }) => void);
      return { close: closes[eventCallbacks.length - 1] ?? vi.fn() };
    });
    const received: string[] = [];

    const sub = subscribeVideoPage(
      { kinds: [34236], limit: 100 },
      (event) => received.push(event.id),
      () => { /* no-op */ },
      ['wss://a.example', 'wss://b.example'],
    );

    eventCallbacks[0]?.({ event: makeEvent('event-1') });
    eventCallbacks[1]?.({ event: makeEvent('event-1') });
    eventCallbacks[1]?.({ event: makeEvent('event-2') });

    expect(received).toEqual(['event-1', 'event-2']);
    sub.close();
    expect(closes[0]).toHaveBeenCalledOnce();
    expect(closes[1]).toHaveBeenCalledOnce();
  });

  it('emits a single aggregated EOSE after every relay leg ends', () => {
    const eoseCallbacks: Array<() => void> = [];
    vi.mocked(relay.subscribe).mockImplementation((_filter, _onEvent, onEose) => {
      eoseCallbacks.push(onEose);
      return { close: vi.fn() };
    });
    const done = vi.fn();

    subscribeVideoPage(
      { kinds: [34236], limit: 100 },
      () => { /* no-op */ },
      done,
      ['wss://a.example', 'wss://b.example'],
    );

    eoseCallbacks[0]?.();
    expect(done).not.toHaveBeenCalled();
    eoseCallbacks[1]?.();
    eoseCallbacks[1]?.();
    expect(done).toHaveBeenCalledOnce();
  });
});
