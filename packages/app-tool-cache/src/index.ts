/** How long a successfully persisted provider result remains reusable. */
export const APP_TOOL_CACHE_TTL_MS = 5 * 60_000;
/**
 * Maximum lifetime of a miss-coordination lease. Provider requests should
 * complete or release their lease within this window.
 */
export const APP_TOOL_CACHE_LEASE_TTL_MS = 30_000;
export const APP_TOOL_CACHE_MAX_BYTES = 1_900_000;

export type AppToolCacheReservation =
  | Readonly<{ status: "hit"; value: string }>
  | Readonly<{ lease: string; status: "leader" }>
  | Readonly<{ status: "retry" }>;

export interface AppToolCacheEntryRpc {
  fulfill(lease: string, value: string, persist: boolean): Promise<boolean>;
  getOrReserve(): Promise<AppToolCacheReservation>;
  release(lease: string): Promise<void>;
  remove(value: string): Promise<void>;
}

export interface AppToolCacheNamespace {
  getByName(name: string): AppToolCacheEntryRpc;
}

export type AppToolCacheJson =
  | boolean
  | null
  | number
  | string
  | readonly AppToolCacheJson[]
  | Readonly<{ [key: string]: AppToolCacheJson }>;

export function isAppToolCacheJson(value: unknown, ancestors = new WeakSet<object>()): value is AppToolCacheJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isAppToolCacheJson(item, ancestors))
    : isPlainRecord(value)
      && Object.values(value).every((item) => isAppToolCacheJson(item, ancestors));
  ancestors.delete(value);
  return valid;
}

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
export function createAppToolCache(
  namespace: AppToolCacheNamespace,
): AppToolCache {
  return {
    async getOrLoad<T extends AppToolCacheJson>(input: AppToolCacheLoadInput<T>): Promise<T> {
      input.signal?.throwIfAborted();
      let entry: AppToolCacheEntryRpc;
      try {
        const key = await hashedCacheKey(input.namespace, input.params);
        entry = namespace.getByName(key);
      } catch {
        input.signal?.throwIfAborted();
        return input.load();
      }

      for (let attempt = 0; attempt < 8; attempt += 1) {
        let reservation: AppToolCacheReservation;
        try {
          reservation = await waitForSignal(entry.getOrReserve(), input.signal);
        } catch {
          input.signal?.throwIfAborted();
          return input.load();
        }

        if (reservation.status === "hit") {
          try {
            return JSON.parse(reservation.value) as T;
          } catch {
            try {
              await entry.remove(reservation.value);
            } catch {
              return input.load();
            }
            continue;
          }
        }
        if (reservation.status === "retry") continue;

        let loaded: T;
        try {
          loaded = await input.load();
        } catch (error) {
          await entry.release(reservation.lease).catch(() => {});
          throw error;
        }

        let value: string | undefined;
        try {
          value = JSON.stringify(loaded);
        } catch {
          await entry.release(reservation.lease).catch(() => {});
          return loaded;
        }
        if (value === undefined) {
          await entry.release(reservation.lease).catch(() => {});
          return loaded;
        }

        let persist = true;
        try {
          persist = input.shouldCache?.(loaded) ?? true;
        } catch {
          persist = false;
        }
        try {
          await entry.fulfill(reservation.lease, value, persist);
        } catch {
          await entry.release(reservation.lease).catch(() => {});
        }
        return loaded;
      }
      input.signal?.throwIfAborted();
      return input.load();
    },
  };
}

async function hashedCacheKey(
  namespace: string,
  params: Readonly<Record<string, unknown>>,
): Promise<string> {
  const normalizedNamespace = namespace.trim();
  if (!normalizedNamespace) throw new Error("cache namespace is required");
  const canonical = `${normalizedNamespace}:${stableJsonStringify(stripUndefined(params), new WeakSet())}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function stripUndefined(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (item === undefined) return [];
      if (Array.isArray(item)) {
        return [[key, item.map((entry) =>
          isPlainRecord(entry) ? stripUndefined(entry) : entry
        )]];
      }
      return [[key, isPlainRecord(item) ? stripUndefined(item) : item]];
    }),
  );
}

function stableJsonStringify(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cache parameters must contain finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error("cache parameters must not be cyclic");
    ancestors.add(value);
    const serialized = `[${value.map((item) => stableJsonStringify(item, ancestors)).join(",")}]`;
    ancestors.delete(value);
    return serialized;
  }
  if (isPlainRecord(value)) {
    if (ancestors.has(value)) throw new Error("cache parameters must not be cyclic");
    ancestors.add(value);
    const serialized = `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJsonStringify(value[key], ancestors)}`
    )).join(",")}}`;
    ancestors.delete(value);
    return serialized;
  }
  throw new Error("cache parameters must be JSON-shaped");
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function waitForSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return promise;
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}
