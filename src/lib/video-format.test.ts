import { describe, expect, it } from 'vitest';
import { formatAge, formatDuration, playbackLabel, playbackNeverStarted, shortNpub } from './video-format.js';

describe('formatDuration', () => {
  it('rolls long videos over into hours instead of 181:00', () => {
    expect(formatDuration(10_860)).toBe('3:01:00');
    expect(formatDuration(3_600)).toBe('1:00:00');
  });

  it('keeps minutes and seconds under the hour', () => {
    expect(formatDuration(48)).toBe('0:48');
    expect(formatDuration(642)).toBe('10:42');
  });

  it('shows nothing when the duration is unknown', () => {
    expect(formatDuration(null)).toBe('');
  });
});

describe('formatAge', () => {
  const now = 1_700_000_000_000;
  const at = (agoSeconds: number) => now / 1000 - agoSeconds;

  it('steps through units', () => {
    expect(formatAge(at(10), now)).toBe('just now');
    expect(formatAge(at(120), now)).toBe('2m ago');
    expect(formatAge(at(7_200), now)).toBe('2h ago');
    expect(formatAge(at(172_800), now)).toBe('2d ago');
    expect(formatAge(at(86_400 * 60), now)).toBe('2mo ago');
    expect(formatAge(at(86_400 * 800), now)).toBe('2y ago');
  });

  it('treats events from the future as new', () => {
    expect(formatAge(at(-500), now)).toBe('just now');
  });
});

describe('shortNpub', () => {
  it('keeps both ends of a real npub', () => {
    const label = shortNpub('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
    expect(label).toBe('npub10xlxvlh…pkge6d');
  });

  it('passes through what it can not encode', () => {
    expect(shortNpub('nope')).toBe('nope');
  });
});

describe('playbackLabel', () => {
  it('says so when the runtime reports a playback error', () => {
    expect(playbackLabel('error', false)).toBe("Can't play this one");
    expect(playbackLabel(null, true)).toBe("Can't play this one");
  });

  it('names the live states', () => {
    expect(playbackLabel('playing', false)).toBe('Now playing');
    expect(playbackLabel('loading', false)).toBe('Loading');
    expect(playbackLabel('paused', false)).toBe('Paused');
  });
});

describe('playbackNeverStarted', () => {
  it('only counts idle straight after loading as a failure', () => {
    expect(playbackNeverStarted('loading', 'idle')).toBe(true);
    expect(playbackNeverStarted('playing', 'idle')).toBe(false);
    expect(playbackNeverStarted('loading', 'playing')).toBe(false);
  });
});
