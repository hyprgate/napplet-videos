import * as nip19 from 'nostr-tools/nip19';

/** `0:48`, `10:42`, or `3:01:00` once a video runs past the hour. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(mins).padStart(2, '0')}:${secs}` : `${mins}:${secs}`;
}

export function formatAge(unixSeconds: number, nowMs: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor(nowMs / 1000) - unixSeconds);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 86_400 * 30) return `${Math.floor(seconds / 86_400)}d ago`;
  if (seconds < 86_400 * 365) return `${Math.floor(seconds / (86_400 * 30))}mo ago`;
  return `${Math.floor(seconds / (86_400 * 365))}y ago`;
}

export function npubFor(pubkey: string): string {
  try {
    return nip19.npubEncode(pubkey);
  } catch {
    return pubkey;
  }
}

/** Keeps both ends of the npub so two people with no profile stay tellable apart. */
export function shortNpub(pubkey: string): string {
  const npub = npubFor(pubkey);
  return npub.length > 20 ? `${npub.slice(0, 12)}…${npub.slice(-6)}` : npub;
}

export type PlaybackLabel = 'Now playing' | 'Loading' | 'Paused' | "Can't play this one" | 'Selected';

export function playbackLabel(state: string | null, error: boolean): PlaybackLabel {
  if (error || state === 'error') return "Can't play this one";
  if (state === 'playing') return 'Now playing';
  if (state === 'loading') return 'Loading';
  if (state === 'paused') return 'Paused';
  return 'Selected';
}

/** The player drops back to idle when a source never loads, rather than reporting an error. */
export function playbackNeverStarted(previous: string | null, next: string | null): boolean {
  return previous === 'loading' && next === 'idle';
}
