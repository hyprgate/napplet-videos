export interface MoviePageRequestInput {
  isLoading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  loadedVideoCount: number;
  oldestSeenCreatedAt: number | null;
}

export interface MoviePageRequest {
  initialLoad: boolean;
  until: number | undefined;
  cursorBefore: number | null;
}

export interface MoviePageSettlementInput {
  pageEventCount: number;
  cursorBefore: number | null;
  oldestSeenCreatedAt: number | null;
  loadedVideoCount?: number;
  pageLimit?: number;
}

export const MOVIE_PAGE_IDLE_SETTLE_MS = 1_500;
export const MOVIE_PAGE_EMPTY_SETTLE_TIMEOUT_MS = 3_000;
export const MOVIE_PAGE_INITIAL_SETTLE_TIMEOUT_MS = 12_000;

export function shouldQueueMoviePageRequest(input: Pick<MoviePageRequestInput, 'isLoading' | 'loadingMore' | 'hasMore'>): boolean {
  return input.hasMore && (input.isLoading || input.loadingMore);
}

export function isMoviePageExhausted(input: MoviePageSettlementInput): boolean {
  const initialPageFilled = input.cursorBefore === null
    && input.pageLimit !== undefined
    && (input.loadedVideoCount ?? 0) >= input.pageLimit;
  if (initialPageFilled) return false;

  return input.pageEventCount === 0 || input.oldestSeenCreatedAt === input.cursorBefore;
}

export function getNextMoviePageRequest(input: MoviePageRequestInput): MoviePageRequest | null {
  if (input.isLoading || input.loadingMore || !input.hasMore) return null;

  return {
    initialLoad: input.loadedVideoCount === 0 && input.oldestSeenCreatedAt === null,
    until: input.oldestSeenCreatedAt === null ? undefined : input.oldestSeenCreatedAt - 1,
    cursorBefore: input.oldestSeenCreatedAt,
  };
}
