import { describe, expect, it } from 'vitest';
import {
  getNextMoviePageRequest,
  isMoviePageExhausted,
  MOVIE_PAGE_EMPTY_SETTLE_TIMEOUT_MS,
  MOVIE_PAGE_IDLE_SETTLE_MS,
  MOVIE_PAGE_INITIAL_SETTLE_TIMEOUT_MS,
  shouldQueueMoviePageRequest,
} from './movie-pagination.js';

describe('getNextMoviePageRequest', () => {
  it('requests the first page without an until cursor', () => {
    expect(getNextMoviePageRequest({
      isLoading: false,
      loadingMore: false,
      hasMore: true,
      loadedVideoCount: 0,
      oldestSeenCreatedAt: null,
    })).toEqual({
      initialLoad: true,
      until: undefined,
      cursorBefore: null,
    });
  });

  it('requests the next page with until set to the oldest seen movie timestamp minus one', () => {
    expect(getNextMoviePageRequest({
      isLoading: false,
      loadingMore: false,
      hasMore: true,
      loadedVideoCount: 1,
      oldestSeenCreatedAt: 1_700_000_000,
    })).toEqual({
      initialLoad: false,
      until: 1_699_999_999,
      cursorBefore: 1_700_000_000,
    });
  });

  it('does not request a page while another request is active or results are exhausted', () => {
    expect(getNextMoviePageRequest({
      isLoading: true,
      loadingMore: false,
      hasMore: true,
      loadedVideoCount: 1,
      oldestSeenCreatedAt: 1_700_000_000,
    })).toBeNull();

    expect(getNextMoviePageRequest({
      isLoading: false,
      loadingMore: true,
      hasMore: true,
      loadedVideoCount: 1,
      oldestSeenCreatedAt: 1_700_000_000,
    })).toBeNull();

    expect(getNextMoviePageRequest({
      isLoading: false,
      loadingMore: false,
      hasMore: false,
      loadedVideoCount: 1,
      oldestSeenCreatedAt: 1_700_000_000,
    })).toBeNull();
  });
});

describe('shouldQueueMoviePageRequest', () => {
  it('remembers boundary-triggered load-more demand while an active page is still in flight', () => {
    expect(shouldQueueMoviePageRequest({ isLoading: true, loadingMore: false, hasMore: true })).toBe(true);
    expect(shouldQueueMoviePageRequest({ isLoading: false, loadingMore: true, hasMore: true })).toBe(true);
  });

  it('does not queue load-more demand after pagination is exhausted', () => {
    expect(shouldQueueMoviePageRequest({ isLoading: true, loadingMore: false, hasMore: false })).toBe(false);
  });
});

describe('isMoviePageExhausted', () => {
  it('treats an empty page as exhausted', () => {
    expect(isMoviePageExhausted({
      pageEventCount: 0,
      cursorBefore: 1_700_000_000,
      oldestSeenCreatedAt: 1_700_000_000,
    })).toBe(true);
  });

  it('treats a page with no older cursor movement as exhausted', () => {
    expect(isMoviePageExhausted({
      pageEventCount: 24,
      cursorBefore: 1_700_000_000,
      oldestSeenCreatedAt: 1_700_000_000,
    })).toBe(true);
  });

  it('keeps paging when the page produced older events', () => {
    expect(isMoviePageExhausted({
      pageEventCount: 24,
      cursorBefore: 1_700_000_000,
      oldestSeenCreatedAt: 1_699_999_900,
    })).toBe(false);
  });

  it('keeps the first full page pageable until an older cursor request proves exhaustion', () => {
    expect(isMoviePageExhausted({
      pageEventCount: 100,
      cursorBefore: null,
      oldestSeenCreatedAt: 1_699_999_900,
      loadedVideoCount: 100,
      pageLimit: 100,
    })).toBe(false);
  });

  it('exports bounded settle timers for live relays that never send EOSE', () => {
    expect(MOVIE_PAGE_IDLE_SETTLE_MS).toBeGreaterThan(0);
    expect(MOVIE_PAGE_EMPTY_SETTLE_TIMEOUT_MS).toBeGreaterThan(MOVIE_PAGE_IDLE_SETTLE_MS);
    expect(MOVIE_PAGE_EMPTY_SETTLE_TIMEOUT_MS).toBeLessThan(MOVIE_PAGE_INITIAL_SETTLE_TIMEOUT_MS);
    expect(MOVIE_PAGE_IDLE_SETTLE_MS).toBeLessThan(MOVIE_PAGE_INITIAL_SETTLE_TIMEOUT_MS);
    expect(MOVIE_PAGE_INITIAL_SETTLE_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });
});
