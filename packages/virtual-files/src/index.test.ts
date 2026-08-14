import { describe, expect, it } from "vitest";
import {
  buildVirtualFileFtsQuery,
  createVirtualFileSearchIndex,
  formatVirtualFindPage,
  isLikelyTextPrefix,
  normalizeVirtualFileSearchText,
  readBoundedTextLines,
  virtualFindInputSchema,
} from "./index.js";

describe("@summonghost/virtual-files", () => {
  it("validates bounded find requests without owning path policy", () => {
    expect(virtualFindInputSchema.parse({ root: "/workspace/notes" }))
      .toEqual({ root: "/workspace/notes" });
    expect(virtualFindInputSchema.safeParse({ root: "" }).success).toBe(false);
    expect(virtualFindInputSchema.safeParse({
      root: "/workspace",
      unknown: true,
    }).success).toBe(false);
  });

  it("normalizes diacritics and quotes user terms for FTS", () => {
    expect(normalizeVirtualFileSearchText("Café")).toBe("cafe");
    expect(buildVirtualFileFtsQuery('pricing OR "secret"'))
      .toBe('"pricing" OR "or" OR "secret"');
    expect(buildVirtualFileFtsQuery(" -- ")).toBeNull();
  });

  it("ranks title and path matches above incidental body matches", () => {
    const index = createVirtualFileSearchIndex([
      {
        id: "body",
        path: "/workspace/notes/misc.md",
        title: "Miscellaneous",
        content: "A passing sentence about pricing.",
      },
      {
        id: "title",
        path: "/workspace/notes/pricing.md",
        title: "Pricing",
        content: "Current tiers and decisions.",
      },
    ]);

    expect(index.search("pricing").map((entry) => entry.id))
      .toEqual(["title", "body"]);
  });

  it("formats one bounded authorized page", () => {
    const output = formatVirtualFindPage({
      root: "/workspace/notes",
      query: "pricing",
      entries: [{
        kind: "file",
        path: "/workspace/notes/pricing&plans.md",
        title: "Pricing <plans>",
        visibility: "private",
        revision: 3,
        snippet: "Use <current> pricing.",
      }],
    });
    expect(output).toContain(
      'path="/workspace/notes/pricing&amp;plans.md"',
    );
    expect(output).not.toContain("revision=");
  });

  it("reads a bounded page without consuming the complete byte stream", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("one\ntwo\nthree\nfour"));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readBoundedTextLines({
      stream,
      sizeBytes: 18,
      offset: 2,
      limit: 2,
      maxLines: 10,
      maxBytes: 100,
    })).resolves.toEqual({
      content: "two\nthree",
      startLine: 2,
      endLine: 3,
      totalLines: null,
      truncated: true,
      nextOffset: 4,
    });
    expect(cancelled).toBe(true);
  });

  it("enforces byte and offset bounds across streamed chunks", async () => {
    const encode = (value: string) => new TextEncoder().encode(value);
    await expect(readBoundedTextLines({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(encode("alpha"));
          controller.enqueue(encode(" beta\nnext"));
          controller.close();
        },
      }),
      sizeBytes: 15,
      maxLines: 10,
      maxBytes: 5,
    })).rejects.toThrow("Line 1 exceeds");
    await expect(readBoundedTextLines({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(encode("one\ntwo"));
          controller.close();
        },
      }),
      sizeBytes: 7,
      offset: 3,
      maxLines: 10,
      maxBytes: 100,
    })).rejects.toThrow("Offset 3 is beyond end");
  });

  it("distinguishes ordinary UTF-8 text from binary prefixes", () => {
    expect(isLikelyTextPrefix(new TextEncoder().encode("hello\nworld"))).toBe(true);
    expect(isLikelyTextPrefix(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0))).toBe(false);
  });
});
