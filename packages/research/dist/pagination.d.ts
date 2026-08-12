export declare const DEFAULT_PAGINATION_CACHE_TTL_MS: number;
export declare const DEFAULT_PAGINATION_CACHE_MAX_ENTRIES = 8;
export declare const DEFAULT_PAGINATION_CACHE_MAX_CHARACTERS = 500000;
export type PaginationCacheEntry = Readonly<{
    content: string;
    createdAt: number;
    key: string;
}>;
export type PaginationCache = Readonly<{
    clear: () => void;
    get: (key: string) => string | null;
    set: (key: string, content: string) => void;
}>;
export type TextPage = Readonly<{
    content: string;
    end: number;
    isFullFirstPage: boolean;
    nextStart?: number;
    partial: boolean;
    previousStart?: number;
    shownCharacters: number;
    start: number;
    totalCharacters: number;
}>;
/**
 * Build a deterministic cache key for JSON-shaped provider inputs.
 * Object property order is ignored; array order remains significant.
 */
export declare function stablePaginationKey(namespace: string, input: Readonly<Record<string, unknown>>): string;
/**
 * Create a synchronous bounded string cache over consumer-owned state.
 *
 * The state may be Agent state, an in-memory array, or any other synchronous
 * persistence boundary. Malformed, expired, future-dated, and oversized
 * entries are removed during reads and writes.
 */
export declare function createPaginationCache(options: {
    getEntries: () => unknown;
    maxCharacters?: number;
    maxEntries?: number;
    now?: () => number;
    setEntries: (entries: readonly PaginationCacheEntry[]) => void;
    ttlMs?: number;
}): PaginationCache;
export declare function paginateText(text: string, input: Readonly<{
    contentStart?: number;
    maxCharacters: number;
    maximumPageCharacters?: number;
}>): TextPage;
