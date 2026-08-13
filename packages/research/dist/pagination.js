export const DEFAULT_PAGINATION_CACHE_TTL_MS = 10 * 60 * 1_000;
export const DEFAULT_PAGINATION_CACHE_MAX_ENTRIES = 8;
export const DEFAULT_PAGINATION_CACHE_MAX_CHARACTERS = 500_000;
/**
 * Build a deterministic cache key for JSON-shaped provider inputs.
 * Object property order is ignored; array order remains significant.
 */
export function stablePaginationKey(namespace, input) {
    const normalizedNamespace = namespace.trim();
    if (!normalizedNamespace) {
        throw new Error("pagination cache namespace is required");
    }
    return `${normalizedNamespace}:${stableJsonStringify(input, new WeakSet())}`;
}
/**
 * Create a synchronous bounded string cache over consumer-owned state.
 *
 * The state may be Agent state, an in-memory array, or any other synchronous
 * persistence boundary. Malformed, expired, future-dated, and oversized
 * entries are removed during reads and writes.
 */
export function createPaginationCache(options) {
    const maxCharacters = positiveSafeInteger(options.maxCharacters ?? DEFAULT_PAGINATION_CACHE_MAX_CHARACTERS, "maxCharacters");
    const maxEntries = positiveSafeInteger(options.maxEntries ?? DEFAULT_PAGINATION_CACHE_MAX_ENTRIES, "maxEntries");
    const ttlMs = positiveSafeInteger(options.ttlMs ?? DEFAULT_PAGINATION_CACHE_TTL_MS, "ttlMs");
    const now = options.now ?? Date.now;
    const readFreshEntries = () => {
        const currentTime = now();
        const cutoff = currentTime - ttlMs;
        const stored = options.getEntries();
        if (!Array.isArray(stored)) {
            return { entries: [], needsRepair: true };
        }
        const entries = stored
            .filter((entry) => {
            const candidate = asRecord(entry);
            return (typeof candidate?.key === "string" &&
                typeof candidate.content === "string" &&
                candidate.content.length <= maxCharacters &&
                typeof candidate.createdAt === "number" &&
                Number.isFinite(candidate.createdAt) &&
                candidate.createdAt >= cutoff &&
                candidate.createdAt <= currentTime);
        })
            .slice(0, maxEntries);
        return {
            entries,
            needsRepair: entries.length !== stored.length,
        };
    };
    return {
        clear() {
            options.setEntries([]);
        },
        get(key) {
            const snapshot = readFreshEntries();
            if (snapshot.needsRepair) {
                options.setEntries(snapshot.entries);
            }
            return (snapshot.entries.find((entry) => entry.key === key)?.content ?? null);
        },
        set(key, content) {
            if (content.length > maxCharacters)
                return;
            const snapshot = readFreshEntries();
            options.setEntries([
                { content, createdAt: now(), key },
                ...snapshot.entries.filter((entry) => entry.key !== key),
            ].slice(0, maxEntries));
        },
    };
}
export function paginateText(text, input) {
    const requestedLimit = positiveSafeInteger(input.maxCharacters, "maxCharacters");
    const maximumLimit = input.maximumPageCharacters === undefined
        ? requestedLimit
        : positiveSafeInteger(input.maximumPageCharacters, "maximumPageCharacters");
    const limit = Math.min(requestedLimit, maximumLimit);
    const requestedStart = nonNegativeSafeInteger(input.contentStart ?? 0, "contentStart");
    const start = Math.min(requestedStart, text.length);
    const end = Math.min(text.length, start + limit);
    return {
        content: text.slice(start, end),
        end,
        isFullFirstPage: start === 0 && text.length <= limit,
        ...(end < text.length && { nextStart: end }),
        partial: end < text.length,
        ...(start > 0 && { previousStart: Math.max(0, start - limit) }),
        shownCharacters: end - start,
        start,
        totalCharacters: text.length,
    };
}
function stableJsonStringify(value, ancestors) {
    if (value === null)
        return "null";
    if (typeof value === "string" || typeof value === "boolean") {
        return JSON.stringify(value);
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new Error("pagination cache inputs must contain finite numbers");
        }
        return JSON.stringify(value);
    }
    if (typeof value !== "object") {
        throw new Error("pagination cache inputs must be JSON values");
    }
    if (ancestors.has(value)) {
        throw new Error("pagination cache inputs must not be cyclic");
    }
    ancestors.add(value);
    let serialized;
    if (Array.isArray(value)) {
        const items = [];
        for (let index = 0; index < value.length; index += 1) {
            if (!(index in value)) {
                throw new Error("pagination cache inputs must not contain array holes");
            }
            items.push(stableJsonStringify(value[index], ancestors));
        }
        serialized = `[${items.join(",")}]`;
    }
    else {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new Error("pagination cache inputs must contain plain objects");
        }
        const record = value;
        serialized = `{${Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key], ancestors)}`)
            .join(",")}}`;
    }
    ancestors.delete(value);
    return serialized;
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
function positiveSafeInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive safe integer`);
    }
    return value;
}
function nonNegativeSafeInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative safe integer`);
    }
    return value;
}
