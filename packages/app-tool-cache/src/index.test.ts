import { describe, expect, it, vi } from "vitest";
import {
  createAppToolCache,
  type AppToolCacheEntryRpc,
  type AppToolCacheReservation,
} from "./index";

class FakeEntry implements AppToolCacheEntryRpc {
  private lease: string | null = null;
  private value: string | null = null;
  private waiters: Array<(value: AppToolCacheReservation) => void> = [];

  async getOrReserve(): Promise<AppToolCacheReservation> {
    if (this.value !== null) return { status: "hit", value: this.value };
    if (this.lease) {
      return await new Promise((resolve) => this.waiters.push(resolve));
    }
    this.lease = crypto.randomUUID();
    return { lease: this.lease, status: "leader" };
  }

  async fulfill(
    lease: string,
    value: string,
    persist: boolean,
  ): Promise<boolean> {
    if (lease !== this.lease) return false;
    if (persist) this.value = value;
    this.lease = null;
    for (const resolve of this.waiters.splice(0)) {
      resolve({ status: "hit", value });
    }
    return persist;
  }

  async release(lease: string): Promise<void> {
    if (lease !== this.lease) return;
    this.lease = null;
    for (const resolve of this.waiters.splice(0)) resolve({ status: "retry" });
  }

  async remove(value: string): Promise<void> {
    if (this.value === value) this.value = null;
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
    await vi.waitFor(() => expect(firstLoad).toHaveBeenCalledTimes(1));
    finish("page");

    await expect(first).resolves.toBe("page");
    await expect(second).resolves.toBe("page");
    expect(secondLoad).not.toHaveBeenCalled();
  });

  it("shares but does not persist results rejected by cache admission", async () => {
    const { cache } = harness();
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
    await vi.waitFor(() => expect(firstLoad).toHaveBeenCalledTimes(1));
    finish("partial");

    await expect(first).resolves.toBe("partial");
    await expect(follower).resolves.toBe("partial");
    expect(followerLoad).not.toHaveBeenCalled();
    await expect(cache.getOrLoad({
      ...input,
      load: async () => "fresh",
    })).resolves.toBe("fresh");
  });

  it("returns successful provider values when serialization fails", async () => {
    const { cache } = harness();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(cache.getOrLoad({
      namespace: "generic:v1",
      params: { id: "cyclic-result" },
      load: async () => cyclic,
    })).resolves.toBe(cyclic);
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
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));

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
    await vi.waitFor(() => expect(firstLoad).toHaveBeenCalledTimes(1));
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
      }),
    });

    await expect(cache.getOrLoad({
      namespace: "places:v1",
      params: { action: "details", place_id: "place-1" },
      load: async () => "provider result",
    })).resolves.toBe("provider result");
  });
});
