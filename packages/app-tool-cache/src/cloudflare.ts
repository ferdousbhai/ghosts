import { DurableObject } from "cloudflare:workers";
import {
  APP_TOOL_CACHE_MAX_BYTES,
  APP_TOOL_CACHE_TTL_MS,
  type AppToolCacheReservation,
} from "./index.js";

const CACHE_KEY = "result";
const CACHE_METADATA_KEY = "result-metadata";
const LEASE_KEY = "lease";
const CACHE_VERSION = 1;
const LEASE_TTL_MS = APP_TOOL_CACHE_TTL_MS;

type CachedMetadata = Readonly<{
  expiresAt: number;
  version: number;
}>;

type StoredLease = Readonly<{
  expiresAt: number;
  lease: string;
}>;

type PendingValue = {
  lease: string;
  promise: Promise<string | null>;
  resolve: (value: string | null) => void;
};

/** One instance per hashed request: shared cache entry plus miss coordination. */
export class AppToolCacheDurableObject extends DurableObject<Cloudflare.Env> {
  private pending: PendingValue | null = null;

  async getOrReserve(): Promise<AppToolCacheReservation> {
    const now = Date.now();
    const [cachedValue, cachedMetadata, storedLease] = await Promise.all([
      this.ctx.storage.get<string>(CACHE_KEY),
      this.ctx.storage.get<CachedMetadata>(CACHE_METADATA_KEY),
      this.ctx.storage.get<StoredLease>(LEASE_KEY),
    ]);
    if (
      cachedMetadata?.version === CACHE_VERSION
      && cachedMetadata.expiresAt > now
      && typeof cachedValue === "string"
      && fitsStorageLimit(cachedValue)
    ) {
      if (storedLease) {
        await this.ctx.storage.delete(LEASE_KEY);
        this.finish(storedLease.lease, cachedValue);
      }
      return { status: "hit", value: cachedValue };
    }
    if (cachedValue !== undefined || cachedMetadata) {
      await this.ctx.storage.delete(CACHE_KEY);
      await this.ctx.storage.delete(CACHE_METADATA_KEY);
    }

    if (storedLease?.expiresAt && storedLease.expiresAt > now) {
      const pending = this.ensurePending(storedLease);
      const value = await pending.promise;
      return value === null ? { status: "retry" } : { status: "hit", value };
    }
    if (storedLease) await this.ctx.storage.delete(LEASE_KEY);
    if (this.pending) this.finish(this.pending.lease, null);

    const lease = crypto.randomUUID();
    const expiresAt = now + LEASE_TTL_MS;
    await this.ctx.storage.put<StoredLease>(LEASE_KEY, { expiresAt, lease });
    try {
      await this.ctx.storage.setAlarm(expiresAt);
    } catch (error) {
      await this.deleteAllStorage();
      throw error;
    }
    this.ensurePending({ expiresAt, lease });
    return { lease, status: "leader" };
  }

  async fulfill(
    lease: string,
    value: string,
    persist: boolean,
  ): Promise<boolean> {
    const storedLease = await this.ctx.storage.get<StoredLease>(LEASE_KEY);
    if (
      storedLease?.lease !== lease
      || storedLease.expiresAt <= Date.now()
    ) {
      if (storedLease?.lease === lease) {
        await this.ctx.storage.delete(LEASE_KEY);
      }
      this.finish(lease, null);
      return false;
    }

    let cacheable = persist && fitsStorageLimit(value);
    if (cacheable) {
      const expiresAt = Date.now() + APP_TOOL_CACHE_TTL_MS;
      await this.ctx.storage.transaction(async (transaction) => {
        await transaction.put<string>(CACHE_KEY, value);
        await transaction.put<CachedMetadata>(CACHE_METADATA_KEY, {
          expiresAt,
          version: CACHE_VERSION,
        });
        await transaction.delete(LEASE_KEY);
      });
      try {
        await this.ctx.storage.setAlarm(expiresAt);
      } catch {
        cacheable = false;
        await this.deleteAllStorage();
      }
    } else {
      await this.deleteAllStorage();
    }
    this.finish(lease, value);
    return cacheable;
  }

  async release(lease: string): Promise<void> {
    const storedLease = await this.ctx.storage.get<StoredLease>(LEASE_KEY);
    if (storedLease?.lease === lease) await this.deleteAllStorage();
    this.finish(lease, null);
  }

  async remove(value: string): Promise<void> {
    const [cachedValue, storedLease] = await Promise.all([
      this.ctx.storage.get<string>(CACHE_KEY),
      this.ctx.storage.get<StoredLease>(LEASE_KEY),
    ]);
    if (cachedValue !== value) return;
    await this.ctx.storage.delete(CACHE_KEY);
    await this.ctx.storage.delete(CACHE_METADATA_KEY);
    if (storedLease?.expiresAt && storedLease.expiresAt > Date.now()) {
      return;
    }
    if (storedLease) {
      await this.ctx.storage.delete(LEASE_KEY);
      this.finish(storedLease.lease, null);
    }
    await this.deleteAllStorage();
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const [cachedValue, cachedMetadata, storedLease] = await Promise.all([
      this.ctx.storage.get<string>(CACHE_KEY),
      this.ctx.storage.get<CachedMetadata>(CACHE_METADATA_KEY),
      this.ctx.storage.get<StoredLease>(LEASE_KEY),
    ]);
    const expirations: number[] = [];
    if (
      cachedMetadata?.version === CACHE_VERSION
      && cachedMetadata.expiresAt > now
      && typeof cachedValue === "string"
      && fitsStorageLimit(cachedValue)
    ) {
      expirations.push(cachedMetadata.expiresAt);
    } else if (cachedValue !== undefined || cachedMetadata) {
      await this.ctx.storage.delete(CACHE_KEY);
      await this.ctx.storage.delete(CACHE_METADATA_KEY);
    }
    if (storedLease?.expiresAt && storedLease.expiresAt > now) {
      expirations.push(storedLease.expiresAt);
    } else if (storedLease) {
      await this.ctx.storage.delete(LEASE_KEY);
      this.finish(storedLease.lease, null);
    }

    const nextExpiration = expirations.length
      ? Math.min(...expirations)
      : null;
    if (nextExpiration !== null) {
      await this.ctx.storage.setAlarm(nextExpiration);
      return;
    }
    await this.deleteAllStorage();
  }

  private ensurePending(input: StoredLease): PendingValue {
    if (this.pending?.lease === input.lease) return this.pending;
    if (this.pending) this.finish(this.pending.lease, null);
    let resolve!: (value: string | null) => void;
    const promise = new Promise<string | null>((complete) => {
      resolve = complete;
    });
    this.pending = {
      lease: input.lease,
      promise,
      resolve,
    };
    return this.pending;
  }

  private finish(lease: string, value: string | null): void {
    if (this.pending?.lease !== lease) return;
    const pending = this.pending;
    this.pending = null;
    pending.resolve(value);
  }

  private async deleteAllStorage(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

function fitsStorageLimit(value: string): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (
      code >= 0xd800
      && code <= 0xdbff
      && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00
      && value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
    if (bytes > APP_TOOL_CACHE_MAX_BYTES) return false;
  }
  return true;
}
