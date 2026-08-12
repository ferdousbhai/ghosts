import { DurableObject } from "cloudflare:workers";
import { type AppToolCacheReservation } from "./index.js";
/** One instance per hashed request: shared cache entry plus miss coordination. */
export declare class AppToolCacheDurableObject extends DurableObject<Cloudflare.Env> {
    private pending;
    getOrReserve(): Promise<AppToolCacheReservation>;
    fulfill(lease: string, value: string, persist: boolean): Promise<boolean>;
    release(lease: string): Promise<void>;
    remove(value: string): Promise<void>;
    alarm(): Promise<void>;
    private ensurePending;
    private finish;
    private deleteAllStorage;
}
