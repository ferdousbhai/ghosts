export declare const APP_TOOL_CACHE_TTL_MS: number;
export declare const APP_TOOL_CACHE_MAX_BYTES = 1900000;
export type AppToolCacheReservation = Readonly<{
    status: "hit";
    value: string;
}> | Readonly<{
    lease: string;
    status: "leader";
}> | Readonly<{
    status: "retry";
}>;
export interface AppToolCacheEntryRpc {
    fulfill(lease: string, value: string, persist: boolean): Promise<boolean>;
    getOrReserve(): Promise<AppToolCacheReservation>;
    release(lease: string): Promise<void>;
    remove(value: string): Promise<void>;
}
export interface AppToolCacheNamespace {
    getByName(name: string): AppToolCacheEntryRpc;
}
export type AppToolCacheJson = boolean | null | number | string | readonly AppToolCacheJson[] | Readonly<{
    [key: string]: AppToolCacheJson;
}>;
export declare function isAppToolCacheJson(value: unknown, ancestors?: WeakSet<object>): value is AppToolCacheJson;
export interface AppToolCache {
    getOrLoad<T extends AppToolCacheJson>(input: AppToolCacheLoadInput<T>): Promise<T>;
}
type AppToolCacheLoadInput<T extends AppToolCacheJson> = Readonly<{
    namespace: string;
    params: Readonly<Record<string, unknown>>;
    load: () => Promise<T>;
    shouldCache?: (value: T) => boolean;
    signal?: AbortSignal;
}>;
/**
 * Build the application cache client over request-keyed Durable Objects. Each
 * object coordinates one exact public provider request, avoiding a singleton
 * bottleneck while deduplicating concurrent misses across Worker isolates.
 */
export declare function createAppToolCache(namespace: AppToolCacheNamespace): AppToolCache;
export {};
