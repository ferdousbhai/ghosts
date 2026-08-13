import { describe, expect, it, vi } from "vitest";
import {
  APP_TOOL_CACHE_LEASE_TTL_MS,
  createAppToolCache,
  type AppToolCacheEntryRpc,
  type AppToolCacheFulfillment,
  type AppToolCacheReservation,
} from "./index";

class FakeEntry implements AppToolCacheEntryRpc {
  private lease: string | null = null;
  private leaseExpiresAt = 0;
  private value: string | null = null;
  private waiters: Array<(value: AppToolCacheReservation) => void> = [];

  async getOrReserve(): Promise<AppToolCacheReservation> {
    if (this.value !== null) return { status: "hit", value: this.value };
    if (this.lease && this.leaseExpiresAt <= Date.now()) {
      this.lease = null;
      for (const resolve of this.waiters.splice(0)) resolve({ status: "retry" });
    }
    if (this.lease) {
      return await new Promise((resolve) => this.waiters.push(resolve));
    }
    this.lease = crypto.randomUUID();
    this.leaseExpiresAt = Date.now() + APP_TOOL_CACHE_LEASE_TTL_MS;
    return { lease: this.lease, status: "leader" };
  }

  async fulfill(
    lease: string,
    value: string,
    persist: boolean,
  ): Promise<AppToolCacheFulfillment> {
    if (lease !== this.lease || this.leaseExpiresAt <= Date.now()) {
      return { accepted: false, persisted: false };
    }
    if (persist) this.value = value;
    this.lease = null;
    this.leaseExpiresAt = 0;
    for (const resolve of this.waiters.splice(0)) {
      resolve({ status: "hit", value });
    }
    return { accepted: true, persisted: persist };
  }

  async release(lease: string): Promise<void> {
    if (lease !== this.lease) return;
    this.lease = null;
    this.leaseExpiresAt = 0;
    for (const resolve of this.waiters.splice(0)) resolve({ status: "retry" });
  }

  async remove(value: string): Promise<void> {
    if (this.value === value) this.value = null;
  }

  async renew(lease: string): Promise<boolean> {
    if (lease !== this.lease || this.leaseExpiresAt <= Date.now()) return false;
    this.leaseExpiresAt = Date.now() + APP_TOOL_CACHE_LEASE_TTL_MS;
    return true;
  }

  getWaiterCountForTest(): number {
    return this.waiters.length;
  }

  setValueForTest(value: string): void {
    this.value = value;
  }
}

function harness() {
  const entries = new Map<string, FakeEntry>();
  const getByName = vi.fn((name: string) => {
    const existing = entries.get(name);
    if (existing) return existing;
    const entry = new FakeEntry();
    entries.set(name, entry);
    return entry;
  });
  return {
    cache: createAppToolCache({ getByName }),
    entries,
    getByName,
  };
}

describe("app-wide tool cache client", () => {
  it("shares stable request results without exposing inputs in object names", async () => {
    const { cache, getByName } = harness();
    const load = vi.fn(async () => ({ result: "shared" }));

    const first = await cache.getOrLoad({
      namespace: "web-search:v1",
      params: { query: "private-looking search", limit: 10 },
      load,
    });
    const second = await cache.getOrLoad({
      namespace: "web-search:v1",
      params: { limit: 10, query: "private-looking search" },
      load,
    });

    expect(first).toEqual({ result: "shared" });
    expect(second).toEqual(first);
    expect(load).toHaveBeenCalledTimes(1);
    expect(getByName).toHaveBeenCalledTimes(2);
    const key = getByName.mock.calls[0]?.[0] ?? "";
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain("private-looking");
    expect(getByName.mock.calls[1]?.[0]).toBe(key);
  });

  it("single-flights concurrent misses", async () => {
    const { cache } = harness();
    let finish!: (value: string) => void;
    const provider = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const firstLoad = vi.fn(() => provider);
    const secondLoad = vi.fn(async () => "duplicate");
    const input = {
      namespace: "read-url:v1",
      params: { urls: ["https://example.com"] },
    } as const;

    const first = cache.getOrLoad({ ...input, load: firstLoad });
    const second = cache.getOrLoad({ ...input, load: secondLoad });
    await vi.waitFor(() => expect(firstLoad).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    finish("page");

    await expect(first).resolves.toBe("page");
    await expect(second).resolves.toBe("page");
    expect(secondLoad).not.toHaveBeenCalled();
  });

  it("keeps loads over 180 seconds single-flight by renewing the leader lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    let finish!: (value: string) => void;
    try {
      const { cache } = harness();
      const provider = new Promise<string>((resolve) => {
        finish = resolve;
      });
      const firstLoad = vi.fn(() => provider);
      const followerLoad = vi.fn(async () => "duplicate");
      const input = {
        namespace: "read-url:long:v1",
        params: { url: "https://example.com/slow" },
      } as const;

      const leader = cache.getOrLoad({ ...input, load: firstLoad });
      await vi.waitFor(() => expect(firstLoad).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(181_000);

      const follower = cache.getOrLoad({ ...input, load: followerLoad });
      await vi.advanceTimersByTimeAsync(0);
      expect(followerLoad).not.toHaveBeenCalled();
      finish("slow result");

      await expect(leader).resolves.toBe("slow result");
      await expect(follower).resolves.toBe("slow result");
      expect(followerLoad).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails open on renewal errors and clears heartbeats on success, error, and abort", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    try {
      const { cache, getByName } = harness();
      let finish!: (value: string) => void;
      const provider = new Promise<string>((resolve) => {
        finish = resolve;
      });
      const successful = cache.getOrLoad({
        namespace: "renewal-failure:v1",
        params: { id: 1 },
        load: () => provider,
      });
      await vi.waitFor(() => expect(getByName).toHaveBeenCalledOnce());
      const entry = getByName.mock.results[0]?.value;
      expect(entry).toBeInstanceOf(FakeEntry);
      const renew = vi.spyOn(entry!, "renew").mockRejectedValue(
        new Error("renewal unavailable"),
      );

      await vi.advanceTimersToNextTimerAsync();
      expect(renew).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersToNextTimerAsync();
      expect(renew).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
      finish("provider result");
      await expect(successful).resolves.toBe("provider result");
      expect(vi.getTimerCount()).toBe(0);

      const failed = cache.getOrLoad({
        namespace: "provider-error:v1",
        params: { id: 2 },
        load: async () => { throw new Error("provider failed"); },
      });
      await expect(failed).rejects.toThrow("provider failed");
      expect(vi.getTimerCount()).toBe(0);

      const controller = new AbortController();
      const aborted = cache.getOrLoad({
        namespace: "provider-abort:v1",
        params: { id: 3 },
        load: () => new Promise<string>(() => {}),
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
      controller.abort();
      await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards a provider result after renewal reports leadership loss", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    let finish!: (value: string) => void;
    let finishRenewal!: (renewed: boolean) => void;
    try {
      const provider = new Promise<string>((resolve) => {
        finish = resolve;
      });
      const renewal = new Promise<boolean>((resolve) => {
        finishRenewal = resolve;
      });
      const entry: AppToolCacheEntryRpc = {
        fulfill: vi.fn(async () => ({ accepted: true, persisted: true } as const)),
        getOrReserve: vi.fn()
          .mockResolvedValueOnce({ lease: "old-lease", status: "leader" })
          .mockResolvedValueOnce({ status: "hit", value: '"winner"' }),
        release: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
        renew: vi.fn(() => renewal),
      };
      const cache = createAppToolCache({ getByName: () => entry });
      const load = vi.fn(() => provider);
      const result = cache.getOrLoad({
        namespace: "leadership-loss:v1",
        params: { id: 1 },
        load,
      });
      await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());

      await vi.advanceTimersByTimeAsync(APP_TOOL_CACHE_LEASE_TTL_MS / 2);
      expect(entry.renew).toHaveBeenCalledOnce();
      finish("stale provider result");
      await vi.advanceTimersByTimeAsync(0);
      expect(entry.fulfill).not.toHaveBeenCalled();
      await expect(Promise.race([result, Promise.resolve("pending")]))
        .resolves.toBe("pending");

      finishRenewal(false);
      await expect(result).resolves.toBe("winner");
      expect(entry.fulfill).not.toHaveBeenCalled();
      expect(entry.getOrReserve).toHaveBeenCalledTimes(2);
      expect(load).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds an unresolved renewal at the lease deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    let finish!: (value: string) => void;
    try {
      const provider = new Promise<string>((resolve) => {
        finish = resolve;
      });
      const entry: AppToolCacheEntryRpc = {
        fulfill: vi.fn(async () => ({ accepted: true, persisted: true } as const)),
        getOrReserve: vi.fn()
          .mockResolvedValueOnce({ lease: "uncertain-lease", status: "leader" })
          .mockResolvedValueOnce({ status: "hit", value: '"winner"' }),
        release: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
        renew: vi.fn(() => new Promise<boolean>(() => {})),
      };
      const cache = createAppToolCache({ getByName: () => entry });
      const result = cache.getOrLoad({
        namespace: "unresolved-renewal:v1",
        params: { id: 1 },
        load: () => provider,
      });
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
      await vi.advanceTimersToNextTimerAsync();
      expect(entry.renew).toHaveBeenCalledOnce();
      finish("stale provider result");
      await vi.advanceTimersByTimeAsync(0);
      expect(entry.fulfill).not.toHaveBeenCalled();

      await vi.advanceTimersToNextTimerAsync();
      await expect(result).resolves.toBe("winner");
      expect(entry.fulfill).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels while waiting for an unresolved renewal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    let finish!: (value: string) => void;
    try {
      const provider = new Promise<string>((resolve) => {
        finish = resolve;
      });
      const entry: AppToolCacheEntryRpc = {
        fulfill: vi.fn(async () => ({ accepted: true, persisted: true } as const)),
        getOrReserve: vi.fn(async () => ({ lease: "uncertain-lease", status: "leader" as const })),
        release: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
        renew: vi.fn(() => new Promise<boolean>(() => {})),
      };
      const controller = new AbortController();
      const cache = createAppToolCache({ getByName: () => entry });
      const result = cache.getOrLoad({
        namespace: "renewal-abort:v1",
        params: { id: 1 },
        load: () => provider,
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(entry.getOrReserve).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(APP_TOOL_CACHE_LEASE_TTL_MS / 2);
      expect(entry.renew).toHaveBeenCalledWith("uncertain-lease");
      finish("provider result");
      await Promise.resolve();
      await Promise.resolve();
      controller.abort();
      await expect(result).rejects.toMatchObject({ name: "AbortError" });
      expect(entry.release).toHaveBeenCalledWith("uncertain-lease");
      expect(entry.fulfill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the coordinated winner when fulfillment rejects an expired lease", async () => {
    const entry: AppToolCacheEntryRpc = {
      fulfill: vi.fn(async () => ({ accepted: false, persisted: false } as const)),
      getOrReserve: vi.fn()
        .mockResolvedValueOnce({ lease: "expired-lease", status: "leader" })
        .mockResolvedValueOnce({ status: "hit", value: '"winner"' }),
      release: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      renew: vi.fn(async () => true),
    };
    const cache = createAppToolCache({ getByName: () => entry });
    const load = vi.fn(async () => "stale provider result");

    await expect(cache.getOrLoad({
      namespace: "fulfillment-loss:v1",
      params: { id: 1 },
      load,
    })).resolves.toBe("winner");
    expect(entry.fulfill).toHaveBeenCalledWith(
      "expired-lease",
      '"stale provider result"',
      true,
    );
    expect(entry.getOrReserve).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledOnce();
  });

  it("shares but does not persist results rejected by cache admission", async () => {
    const { cache, entries } = harness();
    let finish!: (value: string) => void;
    const provider = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const firstLoad = vi.fn(() => provider);
    const followerLoad = vi.fn(async () => "duplicate");
    const input = {
      namespace: "reddit-search:v2",
      params: { query: "transient partial" },
      shouldCache: () => false,
    } as const;

    const first = cache.getOrLoad({ ...input, load: firstLoad });
    const follower = cache.getOrLoad({ ...input, load: followerLoad });
    await vi.waitFor(() => expect(firstLoad).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    await vi.waitFor(() => {
      expect([...entries.values()][0]?.getWaiterCountForTest()).toBe(1);
    });
    finish("partial");

    await expect(first).resolves.toBe("partial");
    await expect(follower).resolves.toBe("partial");
    expect(followerLoad).not.toHaveBeenCalled();
    await expect(cache.getOrLoad({
      ...input,
      load: async () => "fresh",
    })).resolves.toBe("fresh");
  });

  it("does not publish an indeterminate fulfillment result", async () => {
    const entry: AppToolCacheEntryRpc = {
      fulfill: vi.fn(async () => { throw new Error("storage unavailable"); }),
      getOrReserve: vi.fn()
        .mockResolvedValueOnce({ lease: "lease", status: "leader" })
        .mockResolvedValueOnce({ status: "hit", value: '{"result":"winner"}' }),
      release: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      renew: vi.fn(async () => true),
    };
    const cache = createAppToolCache({ getByName: () => entry });
    const load = vi.fn(async () => ({ result: "stale provider" } as const));

    await expect(cache.getOrLoad({
      namespace: "generic:v1",
      params: { id: "storage-failure" },
      load,
    })).resolves.toEqual({ result: "winner" });
    expect(load).toHaveBeenCalledOnce();
    expect(entry.release).toHaveBeenCalledWith("lease");
  });

  it("fails open when key or stub construction fails", async () => {
    const cyclicParams: Record<string, unknown> = {};
    cyclicParams.self = cyclicParams;
    const load = vi.fn(async () => "provider");
    const unavailableNamespace = createAppToolCache({
      getByName: () => {
        throw new Error("namespace unavailable");
      },
    });

    await expect(unavailableNamespace.getOrLoad({
      namespace: "generic:v1",
      params: { id: "stub-failure" },
      load,
    })).resolves.toBe("provider");
    const { cache } = harness();
    await expect(cache.getOrLoad({
      namespace: "generic:v1",
      params: cyclicParams,
      load,
    })).resolves.toBe("provider");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("removes malformed values and refills through single-flight", async () => {
    const { cache, getByName } = harness();
    const input = {
      namespace: "web-search:v1",
      params: { query: "repair" },
    } as const;
    await cache.getOrLoad({ ...input, load: async () => "initial" });
    const entry = getByName.mock.results[0]?.value;
    expect(entry).toBeInstanceOf(FakeEntry);
    entry?.setValueForTest("{malformed");
    const load = vi.fn(async () => "repaired");

    await expect(cache.getOrLoad({ ...input, load })).resolves.toBe("repaired");
    await expect(cache.getOrLoad({ ...input, load })).resolves.toBe("repaired");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("releases a leader lease when the provider is aborted", async () => {
    const { cache } = harness();
    const controller = new AbortController();
    const load = vi.fn(() =>
      new Promise<string>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(controller.signal.reason),
          { once: true },
        );
      })
    );
    const execution = cache.getOrLoad({
      namespace: "read-url:v2",
      params: { urls: ["https://example.com/slow"] },
      load,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1), { timeout: 5_000 });

    controller.abort();

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    await expect(cache.getOrLoad({
      namespace: "read-url:v2",
      params: { urls: ["https://example.com/slow"] },
      load: async () => "retry",
    })).resolves.toBe("retry");
  });

  it("cancels a follower without cancelling the shared leader", async () => {
    const { cache } = harness();
    let finish!: (value: string) => void;
    const provider = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const firstLoad = vi.fn(() => provider);
    const input = {
      namespace: "web-search:v2",
      params: { query: "shared cancellation" },
    } as const;
    const leader = cache.getOrLoad({ ...input, load: firstLoad });
    await vi.waitFor(() => expect(firstLoad).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    const controller = new AbortController();
    const follower = cache.getOrLoad({
      ...input,
      load: async () => "duplicate",
      signal: controller.signal,
    });

    controller.abort();

    await expect(follower).rejects.toMatchObject({ name: "AbortError" });
    finish("shared");
    await expect(leader).resolves.toBe("shared");
    await expect(cache.getOrLoad({
      ...input,
      load: async () => "duplicate",
    })).resolves.toBe("shared");
  });

  it("fails open when shared coordination is unavailable", async () => {
    const cache = createAppToolCache({
      getByName: () => ({
        fulfill: vi.fn(),
        getOrReserve: vi.fn(async () => {
          throw new Error("cache unavailable");
        }),
        release: vi.fn(),
        remove: vi.fn(),
        renew: vi.fn(),
      }),
    });

    await expect(cache.getOrLoad({
      namespace: "places:v1",
      params: { action: "details", place_id: "place-1" },
      load: async () => "provider result",
    })).resolves.toBe("provider result");
  });
});
