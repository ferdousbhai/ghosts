import { describe, expect, it } from "vitest";
import {
  CONTEXT_DOCUMENT_LIMITS,
  extractMarkdownDescription,
  extractMarkdownTitle,
  formatContextDocument,
  formatContextDocumentCatalog,
  normalizeMarkdown,
  reconcileRevisionedDraft,
  type ContextDocument,
} from "./index";

describe("context document helpers", () => {
  it("normalizes Markdown idempotently", () => {
    const once = normalizeMarkdown("# **Title**\n\n\n\n## 1\\. Part\n\nBody  ");
    expect(once).toBe("# Title\n\n## 1. Part\n\nBody");
    expect(normalizeMarkdown(once)).toBe(once);
  });

  it("does not normalize content inside backtick or tilde fences", () => {
    const markdown = [
      "# **Title**",
      "",
      "```md",
      "# **Literal**",
      "",
      "",
      "",
      "## 1\\. Literal  ",
      "```",
      "",
      "~~~",
      "# **Also literal**",
      "~~~~",
      "",
      "## 2\\. Part",
      "",
      "",
      "",
      "Body  ",
    ].join("\n");

    const once = normalizeMarkdown(markdown);
    expect(once).toBe([
      "# Title",
      "",
      "```md",
      "# **Literal**",
      "",
      "",
      "",
      "## 1\\. Literal  ",
      "```",
      "",
      "~~~",
      "# **Also literal**",
      "~~~~",
      "",
      "## 2. Part",
      "",
      "Body",
    ].join("\n"));
    expect(normalizeMarkdown(once)).toBe(once);
  });

  it("preserves the tail of an unclosed fence", () => {
    const fencedTail = "```text\n# **Literal**\n\n\n\nvalue  ";
    expect(normalizeMarkdown(`# **Title**\n\n${fencedTail}`)).toBe(
      `# Title\n\n${fencedTail}`,
    );
  });

  it("handles CRLF and bare-CR lines without dropping content", () => {
    const fenced = "```text\r\n# **Literal**\r\n\r\n\r\nvalue  \r\n```";
    expect(normalizeMarkdown(`# **Title**\r\n\r\n${fenced}\r\nBody  `)).toBe(
      `# Title\r\n\r\n${fenced}\r\nBody`,
    );
    expect(normalizeMarkdown("alpha\rbeta\rgamma")).toBe(
      "alpha\rbeta\rgamma",
    );
  });

  it("collapses excess prose blank lines adjacent to a fence", () => {
    expect(normalizeMarkdown("```\nvalue\n```\n\n\nBody")).toBe(
      "```\nvalue\n```\n\nBody",
    );
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
    expect(extractMarkdownDescription("🙂 trailing", 2)).toBe("…");
    expect(extractMarkdownDescription([
      "# Research",
      "",
      "~~~md",
      "literal code",
      "~~~",
      "",
      "Actual prose.",
    ].join("\n"))).toBe("Actual prose.");
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

  it("rejects catalogs over the document-count or aggregate output bounds", () => {
    const document: ContextDocument = {
      id: "research",
      revision: 1,
      name: "Research",
      description: "",
      markdown: "",
    };
    expect(() => formatContextDocumentCatalog(
      Array.from({ length: CONTEXT_DOCUMENT_LIMITS.documents }, () => document),
    )).not.toThrow();
    expect(() => formatContextDocumentCatalog(
      Array.from({ length: CONTEXT_DOCUMENT_LIMITS.documents + 1 }, () => document),
    )).toThrow(`at most ${CONTEXT_DOCUMENT_LIMITS.documents} documents`);

    const envelopeCharacters = formatContextDocumentCatalog([document]).length;
    const exact = {
      ...document,
      description: "x".repeat(
        CONTEXT_DOCUMENT_LIMITS.outputCharacters - envelopeCharacters,
      ),
    };
    expect(formatContextDocumentCatalog([exact])).toHaveLength(
      CONTEXT_DOCUMENT_LIMITS.outputCharacters,
    );
    expect(() => formatContextDocumentCatalog([{
      ...exact,
      description: `${exact.description}x`,
    }])).toThrow(
      `at most ${CONTEXT_DOCUMENT_LIMITS.outputCharacters} characters`,
    );

    const aggregatePart = {
      ...document,
      description: "x".repeat(
        Math.floor(CONTEXT_DOCUMENT_LIMITS.outputCharacters / 2),
      ),
    };
    expect(() => formatContextDocumentCatalog([
      aggregatePart,
      aggregatePart,
    ])).toThrow(`at most ${CONTEXT_DOCUMENT_LIMITS.outputCharacters} characters`);
  });

  it("measures and renders one immutable snapshot of document fields", () => {
    let markdownReads = 0;
    const volatileDocument: ContextDocument = {
      id: "research",
      revision: 1,
      name: "Research",
      description: "",
      get markdown() {
        markdownReads += 1;
        return markdownReads === 1
          ? ""
          : "x".repeat(CONTEXT_DOCUMENT_LIMITS.outputCharacters);
      },
    };

    expect(formatContextDocument(volatileDocument).length).toBeLessThan(
      CONTEXT_DOCUMENT_LIMITS.outputCharacters,
    );
    expect(markdownReads).toBe(1);
  });

  it("enforces the full-document output bound after escaping", () => {
    const base: ContextDocument = {
      id: "research",
      revision: 1,
      name: "Research",
      description: "",
      markdown: "",
    };
    const envelopeCharacters = formatContextDocument(base).length;
    const exact = {
      ...base,
      markdown: "x".repeat(
        CONTEXT_DOCUMENT_LIMITS.outputCharacters - envelopeCharacters,
      ),
    };
    expect(formatContextDocument(exact)).toHaveLength(
      CONTEXT_DOCUMENT_LIMITS.outputCharacters,
    );
    expect(() => formatContextDocument({
      ...exact,
      markdown: `${exact.markdown}x`,
    })).toThrow(`at most ${CONTEXT_DOCUMENT_LIMITS.outputCharacters} characters`);
    expect(() => formatContextDocument({
      ...base,
      markdown: "&".repeat(
        Math.floor(CONTEXT_DOCUMENT_LIMITS.outputCharacters / 5) + 1,
      ),
    })).toThrow(`at most ${CONTEXT_DOCUMENT_LIMITS.outputCharacters} characters`);
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
