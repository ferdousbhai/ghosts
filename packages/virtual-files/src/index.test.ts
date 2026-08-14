import { describe, expect, it } from "vitest";
import {
  buildVirtualFileFtsQuery,
  createVirtualFileSearchIndex,
  formatVirtualFindPage,
  normalizeVirtualFileSearchText,
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
    expect(formatVirtualFindPage({
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
    })).toContain(
      'path="/workspace/notes/pricing&amp;plans.md"',
    );
  });
});
