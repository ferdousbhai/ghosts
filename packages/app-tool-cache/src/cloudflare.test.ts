import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_TOOL_CACHE_LEASE_TTL_MS,
  APP_TOOL_CACHE_MAX_BYTES,
  APP_TOOL_CACHE_TTL_MS,
  createAppToolCache,
} from "./index";
import { appToolCacheDurableObject } from "./cloudflare";
import { DurableObject } from "cloudflare:workers";

const SharedAppToolCacheDurableObject = appToolCacheDurableObject(DurableObject);
class TestAppToolCacheDurableObject extends SharedAppToolCacheDurableObject {}

interface FakeStorage {
  delete(key: string): Promise<boolean>;
  deleteAlarm(): Promise<void>;
  deleteAll(): Promise<void>;
  get<T>(key: string): Promise<T | undefined>;
  getAlarm(): Promise<number | null>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
  transaction<T>(callback: (transaction: FakeStorage) => Promise<T>): Promise<T>;
}

function createStorage(options: Readonly<{
  failAlarm?: boolean;
  failResultPut?: boolean;
}> = {}): FakeStorage {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage: FakeStorage = {
    async delete(key: string) {
      return values.delete(key);
    },
    async deleteAlarm() {
      alarm = null;
    },
    async deleteAll() {
      values.clear();
    },
    async get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async getAlarm() {
      return alarm;
    },
    async put<T>(key: string, value: T) {
      if (options.failResultPut && key === "result") {
        throw new RangeError("value exceeds storage limit");
      }
      values.set(key, value);
    },
    async setAlarm(scheduledTime: number) {
      if (options.failAlarm) throw new Error("alarm unavailable");
      alarm = scheduledTime;
    },
    async transaction<T>(callback: (transaction: FakeStorage) => Promise<T>) {
      return callback(storage);
    },
  };
  return storage;
}

function entry(storage = createStorage()): TestAppToolCacheDurableObject {
  return new TestAppToolCacheDurableObject(
    { storage } as unknown as DurableObjectState,
    {} as Cloudflare.Env,
  );
}

describe("app-wide tool cache entry", () => {
  const now = new Date("2026-08-09T12:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("persists successful values and schedules physical expiration", async () => {
    const storage = createStorage();
    const cache = entry(storage);
    const reservation = await cache.getOrReserve();
    expect(reservation.status).toBe("leader");
    if (reservation.status !== "leader") return;
    await expect(storage.getAlarm()).resolves.toBe(
      now.getTime() + APP_TOOL_CACHE_LEASE_TTL_MS,
    );

    await expect(cache.fulfill(reservation.lease, '"shared"', true))
      .resolves.toBe(true);
    await expect(storage.getAlarm()).resolves.toBe(
      now.getTime() + APP_TOOL_CACHE_TTL_MS,
    );
    await expect(cache.getOrReserve()).resolves.toEqual({
      status: "hit",
      value: '"shared"',
    });
  });

  it("accepts fulfillment after the object is rehydrated", async () => {
    const storage = createStorage();
    const leader = entry(storage);
    const reservation = await leader.getOrReserve();
    expect(reservation.status).toBe("leader");
    if (reservation.status !== "leader") return;

    const rehydrated = entry(storage);
    await expect(rehydrated.fulfill(reservation.lease, '"durable"', true))
      .resolves.toBe(true);
    await expect(entry(storage).getOrReserve()).resolves.toMatchObject({
      status: "hit",
      value: '"durable"',
    });
  });

  it("deduplicates concurrent misses for the full live lease", async () => {
    const cache = entry();
    const reservation = await cache.getOrReserve();
    expect(reservation.status).toBe("leader");
    if (reservation.status !== "leader") return;

    vi.setSystemTime(now.getTime() + APP_TOOL_CACHE_LEASE_TTL_MS - 1);
    const follower = cache.getOrReserve();
    await expect(Promise.race([follower, Promise.resolve("pending")]))
      .resolves.toBe("pending");
    await cache.fulfill(reservation.lease, '"once"', true);

    await expect(follower).resolves.toEqual({ status: "hit", value: '"once"' });
  });

  it("atomically renews the matching live lease and its alarm", async () => {
    const storage = createStorage();
    const cache = entry(storage);
    const reservation = await cache.getOrReserve();
    expect(reservation.status).toBe("leader");
    if (reservation.status !== "leader") return;
    const follower = cache.getOrReserve();

    const renewedAt = now.getTime() + 20_000;
    vi.setSystemTime(renewedAt);
    const transaction = vi.spyOn(storage, "transaction");
    await expect(cache.renew(reservation.lease)).resolves.toBe(true);
    expect(transaction).toHaveBeenCalledOnce();
    await expect(storage.getAlarm()).resolves.toBe(
      renewedAt + APP_TOOL_CACHE_LEASE_TTL_MS,
    );
    await expect(storage.get<{ expiresAt: number }>("lease")).resolves.toMatchObject({
      expiresAt: renewedAt + APP_TOOL_CACHE_LEASE_TTL_MS,
    });

    vi.setSystemTime(now.getTime() + APP_TOOL_CACHE_LEASE_TTL_MS);
    await cache.alarm();
    await expect(Promise.race([follower, Promise.resolve("pending")]))
      .resolves.toBe("pending");

    vi.setSystemTime(renewedAt + APP_TOOL_CACHE_LEASE_TTL_MS);
    await cache.alarm();
    await expect(follower).resolves.toEqual({ status: "retry" });
  });

  it("keeps the five-minute result TTL independent from the lease", async () => {
    expect(APP_TOOL_CACHE_LEASE_TTL_MS).toBeLessThan(APP_TOOL_CACHE_TTL_MS);
    const storage = createStorage();
    const cache = entry(storage);
    const reservation = await cache.getOrReserve();
    expect(reservation.status).toBe("leader");
    if (reservation.status !== "leader") return;

    const fulfilledAt = now.getTime() + APP_TOOL_CACHE_LEASE_TTL_MS - 1;
    vi.setSystemTime(fulfilledAt);
    await cache.fulfill(reservation.lease, '"temporary"', true);
    const resultExpiresAt = fulfilledAt + APP_TOOL_CACHE_TTL_MS;
    await expect(storage.getAlarm()).resolves.toBe(resultExpiresAt);

    vi.setSystemTime(fulfilledAt + APP_TOOL_CACHE_LEASE_TTL_MS);
    await cache.alarm();
    await expect(storage.get<string>("result")).resolves.toBe('"temporary"');
    await expect(storage.getAlarm()).resolves.toBe(resultExpiresAt);

    vi.setSystemTime(resultExpiresAt);
    await cache.alarm();
    await expect(storage.get<unknown>("result")).resolves.toBeUndefined();
    await expect(storage.getAlarm()).resolves.toBeNull();
  });

  it("expires a dead leader lease and wakes followers to retry", async () => {
    const storage = createStorage();
    const cache = entry(storage);
    const reservation = await cache.getOrReserve();
    expect(reservation.status).toBe("leader");
    if (reservation.status !== "leader") return;
    const follower = cache.getOrReserve();
    await expect(Promise.race([follower, Promise.resolve("pending")]))
      .resolves.toBe("pending");

    vi.setSystemTime(now.getTime() + APP_TOOL_CACHE_LEASE_TTL_MS);
    await expect(cache.renew(reservation.lease)).resolves.toBe(false);
    await cache.alarm();

    await expect(follower).resolves.toEqual({ status: "retry" });
    await expect(storage.get<unknown>("lease")).resolves.toBeUndefined();
    await expect(storage.getAlarm()).resolves.toBeNull();

    const replacement = await cache.getOrReserve();
    expect(replacement.status).toBe("leader");
    if (replacement.status !== "leader") return;
    const replacementFollower = cache.getOrReserve();
    await expect(Promise.race([
      replacementFollower,
      Promise.resolve("pending"),
    ])).resolves.toBe("pending");

    await expect(cache.fulfill(reservation.lease, '"stale"', true))
      .resolves.toBe(false);
    await expect(Promise.race([
      replacementFollower,
      Promise.resolve("pending"),
    ])).resolves.toBe("pending");
    await cache.fulfill(replacement.lease, '"replacement"', true);
    await expect(replacementFollower).resolves.toEqual({
      status: "hit",
      value: '"replacement"',
    });
  });

  it("single-flights byte-oversized values without persisting them", async () => {
    const storage = createStorage();
    const cache = entry(storage);
    const reservation = await cache.getOrReserve();
    expect(reservation.status).toBe("leader");
    if (reservation.status !== "leader") return;
    const follower = cache.getOrReserve();
    const oversized = "€".repeat(Math.floor(APP_TOOL_CACHE_MAX_BYTES / 3) + 1);

    await expect(cache.fulfill(reservation.lease, oversized, true))
      .resolves.toBe(false);
    await expect(follower).resolves.toEqual({
      status: "hit",
      value: oversized,
    });
    await expect(storage.get<unknown>("result")).resolves.toBeUndefined();
    await expect(storage.getAlarm()).resolves.toBeNull();
  });

  it("single-flights results rejected by semantic cache admission", async () => {
    const storage = createStorage();
    const cache = entry(storage);
    const reservation = await cache.getOrReserve();
    expect(reservation.status).toBe("leader");
    if (reservation.status !== "leader") return;
    const follower = cache.getOrReserve();

    await expect(cache.fulfill(reservation.lease, '"partial"', false))
      .resolves.toBe(false);
    await expect(follower).resolves.toEqual({
      status: "hit",
      value: '"partial"',
    });
    await expect(storage.get<unknown>("result")).resolves.toBeUndefined();
  });

  it("fails open and cleans up when persistent storage rejects a result", async () => {
    const storage = createStorage({ failResultPut: true });
    const cacheEntry = entry(storage);
    const cache = createAppToolCache({
      getByName: () => cacheEntry,
    });

    await expect(cache.getOrLoad({
      namespace: "read-url:v2",
      params: { urls: ["https://example.com"] },
      load: async () => "provider result",
    })).resolves.toBe("provider result");
    await expect(storage.get<unknown>("lease")).resolves.toBeUndefined();
    await expect(storage.getAlarm()).resolves.toBeNull();
  });

  it("fails open without leaving a lease when alarms are unavailable", async () => {
    const storage = createStorage({ failAlarm: true });
    const cache = createAppToolCache({
      getByName: () => entry(storage),
    });

    await expect(cache.getOrLoad({
      namespace: "places:v1",
      params: { action: "details", place_id: "place-1" },
      load: async () => "provider result",
    })).resolves.toBe("provider result");
    await expect(storage.get<unknown>("lease")).resolves.toBeUndefined();
    await expect(storage.getAlarm()).resolves.toBeNull();
  });

  it("removes only the malformed value observed by the caller", async () => {
    const cache = entry();
    const reservation = await cache.getOrReserve();
    expect(reservation.status).toBe("leader");
    if (reservation.status !== "leader") return;
    await cache.fulfill(reservation.lease, "{malformed", true);

    await cache.remove('"newer"');
    await expect(cache.getOrReserve()).resolves.toEqual({
      status: "hit",
      value: "{malformed",
    });
    await cache.remove("{malformed");
    await expect(cache.getOrReserve()).resolves.toMatchObject({
      status: "leader",
    });
  });
});
