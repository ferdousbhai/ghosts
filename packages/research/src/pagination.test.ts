import { describe, expect, it } from "vitest";
import {
  createPaginationCache,
  paginateText,
  stablePaginationKey,
  type PaginationCacheEntry,
} from "./index.js";

describe("pagination", () => {
  it("stores bounded entries in consumer-owned state", () => {
    let entries: readonly PaginationCacheEntry[] = [];
    const cache = createPaginationCache({
      getEntries: () => entries,
      now: () => 1_000,
      setEntries: (next) => { entries = next; },
    });
    cache.set("search:key", "full result text");
    expect(cache.get("search:key")).toBe("full result text");
  });

  it("expires and repairs malformed persisted entries", () => {
    let entries: unknown = [
      { content: "kept", createdAt: 900, key: "valid" },
      { content: 42, createdAt: 900, key: "malformed" },
    ];
    const cache = createPaginationCache({
      getEntries: () => entries,
      now: () => 1_000,
      setEntries: (next) => { entries = next; },
      ttlMs: 500,
    });
    expect(cache.get("valid")).toBe("kept");
    expect(entries).toEqual([{ content: "kept", createdAt: 900, key: "valid" }]);
  });

  it("builds stable keys and rejects non-JSON values", () => {
    expect(stablePaginationKey("web_search", { b: 2, a: ["x"] })).toBe(
      stablePaginationKey("web_search", { a: ["x"], b: 2 }),
    );
    expect(() => stablePaginationKey("search", { value: undefined })).toThrow(
      "pagination cache inputs must be JSON values",
    );
  });

  it("returns forward and backward continuation points", () => {
    expect(paginateText("0123456789", {
      contentStart: 4,
      maxCharacters: 100,
      maximumPageCharacters: 3,
    })).toEqual({
      content: "456",
      end: 7,
      isFullFirstPage: false,
      nextStart: 7,
      partial: true,
      previousStart: 1,
      shownCharacters: 3,
      start: 4,
      totalCharacters: 10,
    });
  });
});
