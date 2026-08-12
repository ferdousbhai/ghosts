/** How long a successfully persisted provider result remains reusable. */
export const APP_TOOL_CACHE_TTL_MS = 5 * 60_000;
/**
 * Renewal window for a miss-coordination lease. Active leaders extend their
 * lease within this window; abandoned leases expire after it.
 */
export const APP_TOOL_CACHE_LEASE_TTL_MS = 30_000;
export const APP_TOOL_CACHE_MAX_BYTES = 1_900_000;
export function isAppToolCacheJson(value, ancestors = new WeakSet()) {
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return true;
    if (typeof value === "number")
        return Number.isFinite(value);
    if (typeof value !== "object" || ancestors.has(value))
        return false;
    ancestors.add(value);
    const valid = Array.isArray(value)
        ? value.every((item) => isAppToolCacheJson(item, ancestors))
        : isPlainRecord(value)
            && Object.values(value).every((item) => isAppToolCacheJson(item, ancestors));
    ancestors.delete(value);
    return valid;
}
/**
 * Build the application cache client over request-keyed Durable Objects. Each
 * object coordinates one exact public provider request, avoiding a singleton
 * bottleneck while deduplicating concurrent misses across Worker isolates.
 */
export function createAppToolCache(namespace) {
    return {
        async getOrLoad(input) {
            input.signal?.throwIfAborted();
            let entry;
            try {
                const key = await hashedCacheKey(input.namespace, input.params);
                entry = namespace.getByName(key);
            }
            catch {
                input.signal?.throwIfAborted();
                return input.load();
            }
            for (let attempt = 0; attempt < 8; attempt += 1) {
                let reservation;
                try {
                    reservation = await waitForSignal(entry.getOrReserve(), input.signal);
                }
                catch {
                    input.signal?.throwIfAborted();
                    return input.load();
                }
                if (reservation.status === "hit") {
                    try {
                        return JSON.parse(reservation.value);
                    }
                    catch {
                        try {
                            await entry.remove(reservation.value);
                        }
                        catch {
                            return input.load();
                        }
                        continue;
                    }
                }
                if (reservation.status === "retry")
                    continue;
                const stopHeartbeat = startLeaseHeartbeat(entry, reservation.lease);
                try {
                    let loaded;
                    try {
                        loaded = await waitForSignal(input.load(), input.signal);
                    }
                    catch (error) {
                        stopHeartbeat();
                        await entry.release(reservation.lease).catch(() => { });
                        throw error;
                    }
                    let value;
                    try {
                        value = JSON.stringify(loaded);
                    }
                    catch {
                        stopHeartbeat();
                        await entry.release(reservation.lease).catch(() => { });
                        return loaded;
                    }
                    if (value === undefined) {
                        stopHeartbeat();
                        await entry.release(reservation.lease).catch(() => { });
                        return loaded;
                    }
                    let persist = true;
                    try {
                        persist = input.shouldCache?.(loaded) ?? true;
                    }
                    catch {
                        persist = false;
                    }
                    stopHeartbeat();
                    try {
                        await entry.fulfill(reservation.lease, value, persist);
                    }
                    catch {
                        await entry.release(reservation.lease).catch(() => { });
                    }
                    return loaded;
                }
                finally {
                    stopHeartbeat();
                }
            }
            input.signal?.throwIfAborted();
            return input.load();
        },
    };
}
async function hashedCacheKey(namespace, params) {
    const normalizedNamespace = namespace.trim();
    if (!normalizedNamespace)
        throw new Error("cache namespace is required");
    const canonical = `${normalizedNamespace}:${stableJsonStringify(stripUndefined(params), new WeakSet())}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}
function stripUndefined(value) {
    return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
        if (item === undefined)
            return [];
        if (Array.isArray(item)) {
            return [[key, item.map((entry) => isPlainRecord(entry) ? stripUndefined(entry) : entry)]];
        }
        return [[key, isPlainRecord(item) ? stripUndefined(item) : item]];
    }));
}
function stableJsonStringify(value, ancestors) {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
        return JSON.stringify(value);
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new Error("cache parameters must contain finite numbers");
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        if (ancestors.has(value))
            throw new Error("cache parameters must not be cyclic");
        ancestors.add(value);
        const serialized = `[${value.map((item) => stableJsonStringify(item, ancestors)).join(",")}]`;
        ancestors.delete(value);
        return serialized;
    }
    if (isPlainRecord(value)) {
        if (ancestors.has(value))
            throw new Error("cache parameters must not be cyclic");
        ancestors.add(value);
        const serialized = `{${Object.keys(value).sort().map((key) => (`${JSON.stringify(key)}:${stableJsonStringify(value[key], ancestors)}`)).join(",")}}`;
        ancestors.delete(value);
        return serialized;
    }
    throw new Error("cache parameters must be JSON-shaped");
}
function isPlainRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function startLeaseHeartbeat(entry, lease) {
    let stopped = false;
    let timer;
    const schedule = () => {
        if (stopped)
            return;
        timer = setTimeout(() => {
            timer = undefined;
            void entry.renew(lease).then((renewed) => {
                if (renewed)
                    schedule();
            }, () => schedule());
        }, APP_TOOL_CACHE_LEASE_TTL_MS / 2);
    };
    schedule();
    return () => {
        stopped = true;
        if (timer !== undefined)
            clearTimeout(timer);
        timer = undefined;
    };
}
async function waitForSignal(promise, signal) {
    signal?.throwIfAborted();
    if (!signal)
        return promise;
    return await new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        promise
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", onAbort));
    });
}
