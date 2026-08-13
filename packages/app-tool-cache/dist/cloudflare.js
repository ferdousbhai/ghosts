import { APP_TOOL_CACHE_LEASE_TTL_MS, APP_TOOL_CACHE_MAX_BYTES, APP_TOOL_CACHE_TTL_MS, } from "./index.js";
const CACHE_KEY = "result";
const CACHE_METADATA_KEY = "result-metadata";
const LEASE_KEY = "lease";
const CACHE_VERSION = 1;
/** Add shared cache storage and miss coordination to a consumer's DurableObject base. */
export function appToolCacheDurableObject(DurableObjectBaseClass) {
    class AppToolCacheDurableObject extends DurableObjectBaseClass {
        #pending = null;
        get #cacheStorage() {
            return this.ctx.storage;
        }
        async getOrReserve() {
            const now = Date.now();
            const [cachedValue, cachedMetadata, storedLease] = await Promise.all([
                this.#cacheStorage.get(CACHE_KEY),
                this.#cacheStorage.get(CACHE_METADATA_KEY),
                this.#cacheStorage.get(LEASE_KEY),
            ]);
            if (cachedMetadata?.version === CACHE_VERSION
                && cachedMetadata.expiresAt > now
                && typeof cachedValue === "string"
                && fitsStorageLimit(cachedValue)) {
                if (storedLease) {
                    await this.#cacheStorage.delete(LEASE_KEY);
                    this.#finish(storedLease.lease, cachedValue);
                }
                return { status: "hit", value: cachedValue };
            }
            if (cachedValue !== undefined || cachedMetadata) {
                await this.#cacheStorage.delete(CACHE_KEY);
                await this.#cacheStorage.delete(CACHE_METADATA_KEY);
            }
            if (storedLease?.expiresAt && storedLease.expiresAt > now) {
                const pending = this.#ensurePending(storedLease);
                const value = await pending.promise;
                return value === null ? { status: "retry" } : { status: "hit", value };
            }
            if (storedLease)
                await this.#cacheStorage.delete(LEASE_KEY);
            if (this.#pending)
                this.#finish(this.#pending.lease, null);
            const lease = crypto.randomUUID();
            const expiresAt = now + APP_TOOL_CACHE_LEASE_TTL_MS;
            await this.#cacheStorage.put(LEASE_KEY, { expiresAt, lease });
            try {
                await this.#cacheStorage.setAlarm(expiresAt);
            }
            catch (error) {
                await this.#deleteAllStorage();
                throw error;
            }
            this.#ensurePending({ expiresAt, lease });
            return { lease, status: "leader" };
        }
        async renew(lease) {
            const now = Date.now();
            const expiresAt = now + APP_TOOL_CACHE_LEASE_TTL_MS;
            return await this.#cacheStorage.transaction(async (transaction) => {
                const storedLease = await transaction.get(LEASE_KEY);
                if (storedLease?.lease !== lease || storedLease.expiresAt <= now) {
                    return false;
                }
                await transaction.put(LEASE_KEY, { expiresAt, lease });
                await transaction.setAlarm(expiresAt);
                return true;
            });
        }
        async fulfill(lease, value, persist) {
            const cacheable = persist && fitsStorageLimit(value);
            let fulfillment;
            try {
                fulfillment = await this.#cacheStorage.transaction(async (transaction) => {
                    const storedLease = await transaction.get(LEASE_KEY);
                    if (storedLease?.lease !== lease
                        || storedLease.expiresAt <= Date.now()) {
                        if (storedLease?.lease === lease) {
                            await transaction.delete(LEASE_KEY);
                            await transaction.deleteAlarm();
                        }
                        return { accepted: false, persisted: false };
                    }
                    if (cacheable) {
                        const expiresAt = Date.now() + APP_TOOL_CACHE_TTL_MS;
                        await transaction.put(CACHE_KEY, value);
                        await transaction.put(CACHE_METADATA_KEY, {
                            expiresAt,
                            version: CACHE_VERSION,
                        });
                        await transaction.delete(LEASE_KEY);
                        await transaction.setAlarm(expiresAt);
                        return { accepted: true, persisted: true };
                    }
                    await transaction.delete(CACHE_KEY);
                    await transaction.delete(CACHE_METADATA_KEY);
                    await transaction.delete(LEASE_KEY);
                    await transaction.deleteAlarm();
                    return { accepted: true, persisted: false };
                });
            }
            catch (error) {
                if (!cacheable)
                    throw error;
                fulfillment = await this.#cacheStorage.transaction(async (transaction) => {
                    const storedLease = await transaction.get(LEASE_KEY);
                    if (storedLease?.lease !== lease
                        || storedLease.expiresAt <= Date.now()) {
                        return { accepted: false, persisted: false };
                    }
                    await transaction.delete(CACHE_KEY);
                    await transaction.delete(CACHE_METADATA_KEY);
                    await transaction.delete(LEASE_KEY);
                    await transaction.deleteAlarm();
                    return { accepted: true, persisted: false };
                });
            }
            this.#finish(lease, fulfillment.accepted ? value : null);
            return fulfillment;
        }
        async release(lease) {
            await this.#cacheStorage.transaction(async (transaction) => {
                const storedLease = await transaction.get(LEASE_KEY);
                if (storedLease?.lease !== lease)
                    return;
                await transaction.delete(LEASE_KEY);
                await transaction.deleteAlarm();
            });
            this.#finish(lease, null);
        }
        async remove(value) {
            const [cachedValue, storedLease] = await Promise.all([
                this.#cacheStorage.get(CACHE_KEY),
                this.#cacheStorage.get(LEASE_KEY),
            ]);
            if (cachedValue !== value)
                return;
            await this.#cacheStorage.delete(CACHE_KEY);
            await this.#cacheStorage.delete(CACHE_METADATA_KEY);
            if (storedLease?.expiresAt && storedLease.expiresAt > Date.now()) {
                return;
            }
            if (storedLease) {
                await this.#cacheStorage.delete(LEASE_KEY);
                this.#finish(storedLease.lease, null);
            }
            await this.#deleteAllStorage();
        }
        async alarm() {
            const now = Date.now();
            const [cachedValue, cachedMetadata, storedLease] = await Promise.all([
                this.#cacheStorage.get(CACHE_KEY),
                this.#cacheStorage.get(CACHE_METADATA_KEY),
                this.#cacheStorage.get(LEASE_KEY),
            ]);
            const expirations = [];
            if (cachedMetadata?.version === CACHE_VERSION
                && cachedMetadata.expiresAt > now
                && typeof cachedValue === "string"
                && fitsStorageLimit(cachedValue)) {
                expirations.push(cachedMetadata.expiresAt);
            }
            else if (cachedValue !== undefined || cachedMetadata) {
                await this.#cacheStorage.delete(CACHE_KEY);
                await this.#cacheStorage.delete(CACHE_METADATA_KEY);
            }
            if (storedLease?.expiresAt && storedLease.expiresAt > now) {
                expirations.push(storedLease.expiresAt);
            }
            else if (storedLease) {
                await this.#cacheStorage.delete(LEASE_KEY);
                this.#finish(storedLease.lease, null);
            }
            const nextExpiration = expirations.length
                ? Math.min(...expirations)
                : null;
            if (nextExpiration !== null) {
                await this.#cacheStorage.setAlarm(nextExpiration);
                return;
            }
            await this.#deleteAllStorage();
        }
        #ensurePending(input) {
            if (this.#pending?.lease === input.lease)
                return this.#pending;
            if (this.#pending)
                this.#finish(this.#pending.lease, null);
            let resolve;
            const promise = new Promise((complete) => {
                resolve = complete;
            });
            this.#pending = {
                lease: input.lease,
                promise,
                resolve,
            };
            return this.#pending;
        }
        #finish(lease, value) {
            if (this.#pending?.lease !== lease)
                return;
            const pending = this.#pending;
            this.#pending = null;
            pending.resolve(value);
        }
        async #deleteAllStorage() {
            await this.#cacheStorage.deleteAlarm();
            await this.#cacheStorage.deleteAll();
        }
    }
    return AppToolCacheDurableObject;
}
function fitsStorageLimit(value) {
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code <= 0x7f) {
            bytes += 1;
        }
        else if (code <= 0x7ff) {
            bytes += 2;
        }
        else if (code >= 0xd800
            && code <= 0xdbff
            && index + 1 < value.length
            && value.charCodeAt(index + 1) >= 0xdc00
            && value.charCodeAt(index + 1) <= 0xdfff) {
            bytes += 4;
            index += 1;
        }
        else {
            bytes += 3;
        }
        if (bytes > APP_TOOL_CACHE_MAX_BYTES)
            return false;
    }
    return true;
}
