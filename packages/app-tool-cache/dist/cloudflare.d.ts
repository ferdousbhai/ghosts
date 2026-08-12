import { type AppToolCacheReservation } from "./index.js";
type StoredLease = Readonly<{
    expiresAt: number;
    lease: string;
}>;
type PendingValue = {
    lease: string;
    promise: Promise<string | null>;
    resolve: (value: string | null) => void;
};
type DurableObjectBase = abstract new (...args: any[]) => object;
/** Add shared cache storage and miss coordination to a consumer's DurableObject base. */
export declare function appToolCacheDurableObject<Base extends DurableObjectBase>(DurableObjectBaseClass: Base): (abstract new (...args: any[]) => {
    pending: PendingValue | null;
    get cacheStorage(): DurableObjectStorage;
    getOrReserve(): Promise<AppToolCacheReservation>;
    fulfill(lease: string, value: string, persist: boolean): Promise<boolean>;
    release(lease: string): Promise<void>;
    remove(value: string): Promise<void>;
    alarm(): Promise<void>;
    ensurePending(input: StoredLease): PendingValue;
    finish(lease: string, value: string | null): void;
    deleteAllStorage(): Promise<void>;
}) & Base;
export {};
