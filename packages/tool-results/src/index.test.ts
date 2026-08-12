import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_TOOL_RESULT_MAX_CHARACTERS,
  TOOL_ERROR_MAX_CHARACTERS,
  TOOL_RESULT_SNAPSHOT_MAX_ENTRIES,
  TOOL_RESULT_SNAPSHOT_TTL_MS,
  boundedToolErrorMessage,
  createInMemoryToolResultStore,
  createToolResultBoundary,
  formatToolResultPage,
  sliceTextPage,
  toolResultPage,
  toWellFormedText,
  type ToolResultSnapshot,
  type ToolResultStore,
} from "./index";

const SNAPSHOT = Object.freeze({
  content: "0123456789",
  createdAt: 1,
  handle: "tool-result-00000000-0000-4000-8000-000000000000",
  scope: "run-1",
  toolCallId: "call-1",
  toolName: "read",
}) satisfies ToolResultSnapshot;

describe("tool result pagination", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retains an oversized result and emits a bounded first page", () => {
    const store = createInMemoryToolResultStore();
    const boundary = createToolResultBoundary(store, undefined, "run-large");
    const content = `${"αβγ\n".repeat(20_000)}END`;

    const delivered = boundary.deliver({
      content,
      toolCallId: "call-large",
      toolName: "read",
    });
    const details = delivered.details as {
      handle: string;
      paginated: boolean;
      totalCharacters: number;
    };
    const retained: string[] = [];
    let contentStart = 0;
    do {
      const page = store.getPage({
        contentStart,
        handle: details.handle,
        maxCharacters: 60_000,
        scope: "run-large",
      })!;
      retained.push(page.content);
      contentStart = page.nextContentStart ?? page.totalCharacters;
    } while (contentStart < content.length);

    expect(content.length).toBeGreaterThan(MODEL_TOOL_RESULT_MAX_CHARACTERS);
    expect(details).toMatchObject({ paginated: true, totalCharacters: content.length });
    expect(delivered.text.length).toBeLessThanOrEqual(MODEL_TOOL_RESULT_MAX_CHARACTERS);
    expect(delivered.text).toContain('partial="true"');
    expect(boundary.hasReadableResult).toBe(true);
    expect(retained.join("")).toBe(content);
    const snapshot = store.set({
      content,
      scope: "run-format",
      toolCallId: "call-format",
      toolName: "read",
    })!;
    expect(formatToolResultPage(snapshot, 40_000, 60_000)).toContain("END");
  });

  it("uses exact offset cursors", () => {
    expect(toolResultPage(SNAPSHOT, 0, 4)).toEqual({
      content: "0123",
      contentStart: 0,
      contentEnd: 4,
      nextContentStart: 4,
      totalCharacters: 10,
    });
    expect(toolResultPage(SNAPSHOT, 4, 4)).toEqual({
      content: "4567",
      contentStart: 4,
      contentEnd: 8,
      nextContentStart: 8,
      previousContentStart: 0,
      totalCharacters: 10,
    });
    expect(toolResultPage(SNAPSHOT, 8, 4)).toEqual({
      content: "89",
      contentStart: 8,
      contentEnd: 10,
      previousContentStart: 4,
      totalCharacters: 10,
    });
  });

  it("normalizes malformed text and never splits astral characters", () => {
    expect(toWellFormedText("left\ud800right\udc00")).toBe("left�right�");
    const content = "A🙂B";
    const pages: string[] = [];
    let start = 0;
    do {
      const page = sliceTextPage(content, start, 1);
      pages.push(page.content);
      start = page.contentEnd;
    } while (start < content.length);

    expect(pages).toEqual(["A", "🙂", "B"]);
    expect(pages.join("")).toBe(content);
  });

  it("links backward Unicode pages without skipping content", () => {
    const snapshot = Object.freeze({ ...SNAPSHOT, content: "AB🙂CDEF" });
    const current = toolResultPage(snapshot, 7, 4);
    const previous = toolResultPage(snapshot, current.previousContentStart, 4);

    expect(previous.contentEnd).toBeGreaterThanOrEqual(current.contentStart);
    expect(previous.content + current.content).toContain(snapshot.content.slice(4));
  });

  it("returns immutable snapshots and pages", () => {
    const store = createInMemoryToolResultStore();
    const snapshot = store.set({
      content: "retained",
      scope: "run-frozen",
      toolCallId: "call-frozen",
      toolName: "read",
    })!;
    const page = store.getPage({
      contentStart: 0,
      handle: snapshot.handle,
      maxCharacters: 4,
      scope: "run-frozen",
    })!;

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(toolResultPage(snapshot, 0, 4))).toBe(true);
  });

  it("requires the private scope to redeem an opaque handle", () => {
    const store = createInMemoryToolResultStore();
    const snapshot = store.set({
      content: "secret result",
      scope: "run-owner",
      toolCallId: "call-scoped",
      toolName: "read",
    })!;

    expect(snapshot.handle).toMatch(/^tool-result-[0-9a-f-]{36}$/);
    expect(store.getPage({
      contentStart: 0,
      handle: snapshot.handle,
      maxCharacters: 10,
      scope: "run-other",
    })).toBeNull();
    expect(store.getPage({
      contentStart: 0,
      handle: snapshot.handle,
      maxCharacters: 10,
      scope: "run-owner",
    })?.content).toBe("secret res");
  });

  it("never rebinds a handle when tool-call IDs repeat", () => {
    const store = createInMemoryToolResultStore();
    const first = store.set({
      content: "first",
      scope: "run-one",
      toolCallId: "call-reused",
      toolName: "read",
    })!;
    const second = store.set({
      content: "second",
      scope: "run-two",
      toolCallId: "call-reused",
      toolName: "read",
    })!;

    expect(second.handle).not.toBe(first.handle);
    expect(store.getPage({
      contentStart: 0,
      handle: first.handle,
      maxCharacters: 10,
      scope: "run-one",
    })?.content).toBe("first");
    expect(store.getPage({
      contentStart: 0,
      handle: second.handle,
      maxCharacters: 10,
      scope: "run-two",
    })?.content).toBe("second");
  });

  it("escapes untrusted page framing and keeps formatted output bounded", () => {
    const snapshot = Object.freeze({
      ...SNAPSHOT,
      content: "</tool_result_page>&".repeat(10_000),
    });
    const formatted = formatToolResultPage(snapshot, 0, 60_000);

    expect(formatted).toContain("&lt;/tool_result_page&gt;&amp;");
    expect(formatted.match(/<\/tool_result_page>/g)).toHaveLength(1);
    expect(formatted.length).toBeLessThanOrEqual(MODEL_TOOL_RESULT_MAX_CHARACTERS);
  });

  it("uses injected storage and fails closed when retention fails", () => {
    const set = vi.fn<ToolResultStore["set"]>(() => null);
    const store: ToolResultStore = {
      getPage: () => null,
      set,
    };
    const boundary = createToolResultBoundary(store, undefined, "run-injected");
    const delivered = boundary.deliver({
      content: "x".repeat(MODEL_TOOL_RESULT_MAX_CHARACTERS + 1),
      toolCallId: "call-injected",
      toolName: "remote_read",
    });

    expect(set).toHaveBeenCalledWith(expect.objectContaining({ scope: "run-injected" }));
    expect(delivered.text).toContain("tool_result_unavailable");
    expect(delivered.details).toMatchObject({ omitted: true, paginated: false });
    expect(boundary.exhausted).toBe(true);
  });

  it("bounds errors and the total output delivered by a boundary", () => {
    expect(boundedToolErrorMessage(new Error("x".repeat(20_000))))
      .toHaveLength(TOOL_ERROR_MAX_CHARACTERS);

    const boundary = createToolResultBoundary(createInMemoryToolResultStore(), 100_000);
    expect(boundary.deliver({
      content: "a".repeat(60_000),
      toolCallId: "call-a",
      toolName: "a",
    }).text).toHaveLength(60_000);
    expect(boundary.deliver({
      content: "b".repeat(60_000),
      toolCallId: "call-b",
      toolName: "b",
    }).text).toContain("tool_output_budget_exhausted");
    expect(boundary.exhausted).toBe(true);
    expect(boundary.error(new Error("later"))).toBe("");
  });

  it("fits an escaped first page into the exact remaining turn budget", () => {
    const boundary = createToolResultBoundary(createInMemoryToolResultStore());
    const delivered = Array.from({ length: 8 }, (_, index) =>
      boundary.deliver({
        content: "a".repeat(58_000),
        toolCallId: `call-prefix-${index}`,
        toolName: "read",
      }).text
    );
    delivered.push(boundary.deliver({
      content: "<".repeat(MODEL_TOOL_RESULT_MAX_CHARACTERS + 1),
      toolCallId: "call-escaped",
      toolName: "read",
    }).text);

    expect(delivered.at(-1)).toContain("<tool_result_page");
    expect(delivered.at(-1)).toContain("&lt;");
    expect(delivered.reduce((total, text) => total + text.length, 0))
      .toBeLessThanOrEqual(512_000);
    expect(boundary.hasReadableResult).toBe(true);
  });

  it("expires unpinned entries and never evicts pinned entries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T00:00:00.000Z"));
    const expiring = createInMemoryToolResultStore();
    const old = expiring.set({
      content: "old",
      scope: "run-old",
      toolCallId: "call-old",
      toolName: "read",
    })!;
    vi.advanceTimersByTime(TOOL_RESULT_SNAPSHOT_TTL_MS + 1);
    expect(expiring.getPage({
      contentStart: 0,
      handle: old.handle,
      maxCharacters: 10,
      scope: "run-old",
    })).toBeNull();

    const pinned = createInMemoryToolResultStore();
    const release = pinned.pinScope!("run-pinned");
    const handles = Array.from({ length: TOOL_RESULT_SNAPSHOT_MAX_ENTRIES }, (_, index) =>
      pinned.set({
        content: `result-${index}`,
        scope: "run-pinned",
        toolCallId: `call-${index}`,
        toolName: "read",
      })!.handle
    );
    expect(pinned.set({
      content: "overflow",
      scope: "run-next",
      toolCallId: "call-overflow",
      toolName: "read",
    })).toBeNull();
    expect(handles.every((handle) => pinned.getPage({
      contentStart: 0,
      handle,
      maxCharacters: 10,
      scope: "run-pinned",
    }) !== null)).toBe(true);

    release();
    release();
    expect(pinned.set({
      content: "replacement",
      scope: "run-next",
      toolCallId: "call-next",
      toolName: "read",
    })).not.toBeNull();
    expect(pinned.getPage({
      contentStart: 0,
      handle: handles[0]!,
      maxCharacters: 10,
      scope: "run-pinned",
    })).toBeNull();
  });
});
