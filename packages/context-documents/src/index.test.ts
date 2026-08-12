import { describe, expect, it } from "vitest";
import {
  extractMarkdownDescription,
  extractMarkdownTitle,
  formatContextDocument,
  formatContextDocumentCatalog,
  normalizeMarkdown,
  reconcileRevisionedDraft,
} from "./index";

describe("context document helpers", () => {
  it("normalizes Markdown idempotently", () => {
    const once = normalizeMarkdown("# **Title**\n\n\n\n## 1\\. Part\n\nBody  ");
    expect(once).toBe("# Title\n\n## 1. Part\n\nBody");
    expect(normalizeMarkdown(once)).toBe(once);
  });

  it("extracts title and first prose description", () => {
    const markdown =
      "# Research\n\n## Scope\n\nReturn a **short**, sourced brief.\n\nMore.";
    expect(extractMarkdownTitle(markdown)).toBe("Research");
    expect(extractMarkdownTitle("Body", "Fallback")).toBe("Fallback");
    expect(extractMarkdownDescription(markdown)).toBe(
      "Return a short, sourced brief.",
    );
    expect(extractMarkdownDescription("# Title\n\nA long description", 8)).toBe(
      "A long…",
    );
    expect(extractMarkdownDescription(markdown, 0)).toBe("");
    expect(() => extractMarkdownDescription(markdown, Number.NaN)).toThrow(
      "maximumCharacters must be a non-negative safe integer",
    );
  });

  it("renders bounded metadata separately from a full document", () => {
    const document = {
      id: "research&brief",
      revision: 3,
      name: "Research <brief>",
      description: "Use when sources are needed.",
      markdown: "# Research\n\nNever invent <sources>.",
    };
    expect(formatContextDocumentCatalog([document])).not.toContain(
      "Never invent",
    );
    expect(formatContextDocumentCatalog([document])).toContain(
      "research&amp;brief",
    );
    expect(formatContextDocument(document)).toContain(
      "Never invent &lt;sources&gt;.",
    );
  });

  it("preserves dirty drafts when a concurrent revision arrives", () => {
    expect(
      reconcileRevisionedDraft({
        baselineContent: "old",
        currentDraft: "local",
        nextContent: "remote",
      }),
    ).toEqual({ draft: "local", conflict: true, replaceEditorContent: false });
    expect(
      reconcileRevisionedDraft({
        baselineContent: "old",
        currentDraft: "old",
        nextContent: "remote",
      }),
    ).toEqual({ draft: "remote", conflict: false, replaceEditorContent: true });
  });
});
