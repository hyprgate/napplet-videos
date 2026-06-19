import { relay, type Subscription } from '@napplet/sdk';
import type { NostrEvent, NostrFilter } from '@hyprgate/types';

export const VIDEO_RELAY_HINTS = [
  'wss://relay.divine.video',
  'wss://relay.nostr.band',
  'wss://nos.lol',
  'wss://relay.damus.io',
  'wss://nostr.mom',
  'wss://relay.primal.net',
] as const;

export function subscribeVideoPage(
  filter: NostrFilter,
  onEvent: (event: NostrEvent) => void,
  onEose: () => void,
  relayUrls: readonly string[] = VIDEO_RELAY_HINTS,
): Subscription {
  const seenIds = new Set<string>();
  const subscriptions: Subscription[] = [];
  let remainingEose = relayUrls.length;
  let eoseSent = false;

  function maybeEose(): void {
    if (eoseSent || remainingEose > 0) return;
    eoseSent = true;
    onEose();
  }

  for (const relayUrl of relayUrls) {
    try {
      subscriptions.push(relay.subscribe(
        filter,
        (event) => {
          if (seenIds.has(event.id)) return;
          seenIds.add(event.id);
          onEvent(event as NostrEvent);
        },
        () => {
          remainingEose -= 1;
          maybeEose();
        },
        { relay: relayUrl },
      ));
    } catch {
      remainingEose -= 1;
    }
  }

  if (subscriptions.length === 0) {
    return relay.subscribe(filter, onEvent, onEose);
  }

  maybeEose();

  return {
    close: () => {
      for (const subscription of subscriptions) subscription.close();
    },
  };
}
