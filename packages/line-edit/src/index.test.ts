import { describe, expect, it } from "vitest";
import {
  StaleSnapshotError,
  applyLineEdits,
  assertSnapshotVersion,
  numberReadContent,
  numberedRead,
  snapshotVersion,
  type MappedLineEdit,
} from "./index";

const SHA256 = "ab".repeat(32);

type SummonGhostSplice = {
  startLine: number;
  deleteLines: number;
  content: string;
};

const mapSummonGhostSplice = (edit: SummonGhostSplice): MappedLineEdit => edit;

type GhostbuildOperation =
  | { startLine: number; endLine: number; content: string }
  | { afterLine: number; content: string };

function mapGhostbuildOperation(edit: GhostbuildOperation): MappedLineEdit {
  if ("afterLine" in edit) {
    return { startLine: edit.afterLine + 1, deleteLines: 0, content: edit.content };
  }
  return {
    startLine: edit.startLine,
    deleteLines: edit.endLine - edit.startLine + 1,
    content: edit.content,
  };
}

describe("snapshot versions", () => {
  it("supports each consumer's current version length and casing", () => {
    expect(snapshotVersion(SHA256, { length: 24, letterCase: "upper" })).toBe(
      "ABABABABABABABABABABABAB",
    );
    expect(snapshotVersion(SHA256.toUpperCase(), { length: 32 })).toBe(
      "abababababababababababababababab",
    );
  });

  it("rejects invalid digests and stale versions without exposing policy", () => {
    expect(() => snapshotVersion("not-a-digest", { length: 24 })).toThrow(
      "SHA-256",
    );
    expect(() => snapshotVersion(SHA256, { length: 65 })).toThrow("1 to 64");
    expect(() => snapshotVersion(SHA256, {
      length: 24,
      letterCase: "mixed" as "lower",
    })).toThrow("letterCase");
    expect(() =>
      assertSnapshotVersion(
        "stale",
        SHA256,
        { length: 32 },
        "File changed after it was read.",
      )
    ).toThrowError(new StaleSnapshotError("File changed after it was read."));
    expect(assertSnapshotVersion("ABAB", SHA256, {
      length: 4,
      letterCase: "upper",
    })).toBe("ABAB");
  });
});

describe("numbered reads", () => {
  it("returns a bounded numbered range and continuation metadata", () => {
    expect(numberedRead({
      content: "one\r\ntwo\r\nthree\r\n",
      offset: 2,
      limit: 1,
      maxLines: 2_000,
      maxBytes: 256 * 1024,
    })).toEqual({
      content: "2:two",
      startLine: 2,
      endLine: 2,
      totalLines: 3,
      truncated: true,
      nextOffset: 3,
    });
  });

  it("enforces the UTF-8 byte cap without splitting a numbered line", () => {
    expect(numberedRead({
      content: "a\n😀\nc",
      maxLines: 10,
      maxBytes: 7,
    })).toMatchObject({ content: "1:a", endLine: 1, truncated: true });
    expect(() => numberedRead({
      content: "😀",
      maxLines: 10,
      maxBytes: 5,
    })).toThrow("Line 1 exceeds");
  });

  it("uses the same BOM-aware logical lines for reads and edits", () => {
    expect(numberedRead({
      content: "\uFEFFalpha\r\nbeta\r\n",
      maxLines: 10,
      maxBytes: 100,
    })).toMatchObject({ content: "1:alpha\n2:beta", totalLines: 2 });
    expect(numberedRead({
      content: "\uFEFF",
      maxLines: 10,
      maxBytes: 100,
    })).toMatchObject({ content: "", totalLines: 0 });
    expect(numberedRead({
      content: "\uFEFF\n",
      maxLines: 10,
      maxBytes: 100,
    })).toMatchObject({ content: "1:", totalLines: 1 });
  });

  it("handles empty snapshots and validates pagination", () => {
    expect(numberedRead({ content: "", maxLines: 10, maxBytes: 100 })).toEqual({
      content: "",
      startLine: 1,
      endLine: 0,
      totalLines: 0,
      truncated: false,
    });
    expect(() => numberedRead({
      content: "",
      offset: 2,
      maxLines: 10,
      maxBytes: 100,
    })).toThrow("beyond end");
    expect(() => numberedRead({
      content: "one",
      maxLines: 0,
      maxBytes: 100,
    })).toThrow("maxLines");
  });

  it("numbers consumer-selected chunks while retaining their display shape", () => {
    expect(numberReadContent("beta\rgamma", 2)).toBe("2:beta\n3:gamma");
    expect(numberReadContent("\uFEFFalpha\n", 1)).toBe("1:alpha\n2:");
    expect(numberReadContent("\uFEFFalpha", 2)).toBe("2:\uFEFFalpha");
    expect(numberReadContent("\uFEFF", 1)).toBe("");
    expect(numberReadContent("", 1)).toBe("");
  });
});

describe("mapped line edits", () => {
  it("applies SummonGhost splices to one original BOM/CRLF snapshot", () => {
    const result = applyLineEdits({
      content: "\uFEFFalpha\r\nbeta\r\ngamma\r\ndelta\r\nepsilon\r\n",
      edits: [
        { startLine: 2, deleteLines: 1, content: "BETA" },
        { startLine: 4, deleteLines: 0, content: "between" },
        { startLine: 5, deleteLines: 1, content: "" },
      ],
      mapEdit: mapSummonGhostSplice,
      maxEdits: 50,
    });

    expect(result).toEqual({
      content: "\uFEFFalpha\r\nBETA\r\ngamma\r\nbetween\r\ndelta\r\n",
      editsApplied: 3,
      firstChangedLine: 2,
      changes: [
        { operationIndex: 0, startLine: 2, deletedLines: 1, insertedLines: 1 },
        { operationIndex: 1, startLine: 4, deletedLines: 0, insertedLines: 1 },
        { operationIndex: 2, startLine: 5, deletedLines: 1, insertedLines: 0 },
      ],
    });
  });

  it("maps Ghostbuild replacements and after-line insertions", () => {
    const result = applyLineEdits({
      content: "one\r\ntwo\r\nthree\r\nfour\r\n",
      edits: [
        { startLine: 2, endLine: 3, content: "TWO\nTHREE" },
        { afterLine: 1, content: "between" },
        { afterLine: 4, content: "five" },
      ] satisfies GhostbuildOperation[],
      mapEdit: mapGhostbuildOperation,
      maxEdits: 100,
      allowInsertionAtReplacementStart: true,
    });

    expect(result.content).toBe(
      "one\r\nbetween\r\nTWO\r\nTHREE\r\nfour\r\nfive\r\n",
    );
    expect(result.firstChangedLine).toBe(2);
  });

  it("preserves a lone-CR style and the absence of a final newline", () => {
    expect(applyLineEdits({
      content: "one\rtwo\rthree",
      edits: [{ startLine: 2, deleteLines: 1, content: "TWO\n2.5" }],
      mapEdit: mapSummonGhostSplice,
      maxEdits: 50,
    }).content).toBe("one\rTWO\r2.5\rthree");
  });

  it("supports insertion into an empty snapshot and deletion of all lines", () => {
    expect(applyLineEdits({
      content: "",
      edits: [{ startLine: 1, deleteLines: 0, content: "first" }],
      mapEdit: mapSummonGhostSplice,
      maxEdits: 50,
    }).content).toBe("first");
    expect(applyLineEdits({
      content: "\uFEFFonly\n",
      edits: [{ startLine: 1, deleteLines: 1, content: "" }],
      mapEdit: mapSummonGhostSplice,
      maxEdits: 50,
    }).content).toBe("\uFEFF");
  });

  it("rejects overlapping replacements, internal insertions, and shared insertion points", () => {
    expect(() => applyLineEdits({
      content: "one\ntwo\nthree",
      edits: [
        { startLine: 1, deleteLines: 2, content: "changed" },
        { startLine: 2, deleteLines: 1, content: "overlap" },
      ],
      mapEdit: mapSummonGhostSplice,
      maxEdits: 50,
    })).toThrow("overlap");

    expect(() => applyLineEdits({
      content: "one\ntwo\nthree",
      edits: [
        { startLine: 1, endLine: 2, content: "changed" },
        { afterLine: 1, content: "inside" },
      ] satisfies GhostbuildOperation[],
      mapEdit: mapGhostbuildOperation,
      maxEdits: 100,
      allowInsertionAtReplacementStart: true,
    })).toThrow("overlap");

    expect(() => applyLineEdits({
      content: "one",
      edits: [
        { startLine: 1, deleteLines: 0, content: "a" },
        { startLine: 1, deleteLines: 0, content: "b" },
      ],
      mapEdit: mapSummonGhostSplice,
      maxEdits: 50,
    })).toThrow("insertion point");
  });

  it("allows insertions immediately after replacements, including at EOF", () => {
    expect(applyLineEdits({
      content: "one\ntwo\nthree",
      edits: [
        { startLine: 1, endLine: 2, content: "changed" },
        { afterLine: 2, content: "after" },
        { afterLine: 3, content: "last" },
      ] satisfies GhostbuildOperation[],
      mapEdit: mapGhostbuildOperation,
      maxEdits: 100,
      allowInsertionAtReplacementStart: true,
    }).content).toBe("changed\nafter\nthree\nlast");
  });

  it("lets consumers choose whether insertion at a replacement start conflicts", () => {
    const edits: GhostbuildOperation[] = [
      { startLine: 2, endLine: 2, content: "TWO" },
      { afterLine: 1, content: "before" },
    ];
    expect(applyLineEdits({
      content: "one\ntwo\nthree",
      edits,
      mapEdit: mapGhostbuildOperation,
      maxEdits: 100,
      allowInsertionAtReplacementStart: true,
    }).content).toBe("one\nbefore\nTWO\nthree");

    expect(() => applyLineEdits({
      content: "one\ntwo\nthree",
      edits,
      mapEdit: mapGhostbuildOperation,
      maxEdits: 100,
    })).toThrow("overlap");
  });

  it("rejects out-of-bounds, empty, excessive, and no-op edits", () => {
    expect(() => applyLineEdits({
      content: "one",
      edits: [{ startLine: 2, deleteLines: 1, content: "later" }],
      mapEdit: mapSummonGhostSplice,
      maxEdits: 50,
    })).toThrow("content has 1 line");
    expect(() => applyLineEdits({
      content: "one",
      edits: [{ startLine: 1, deleteLines: 0, content: "" }],
      mapEdit: mapSummonGhostSplice,
      maxEdits: 50,
    })).toThrow("does not delete or insert");
    expect(() => applyLineEdits({
      content: "one",
      edits: [
        { startLine: 1, deleteLines: 1, content: "one" },
        { startLine: 2, deleteLines: 0, content: "two" },
      ],
      mapEdit: mapSummonGhostSplice,
      maxEdits: 1,
    })).toThrow("at most 1");
    expect(() => applyLineEdits({
      content: "one\n",
      edits: [{ startLine: 1, deleteLines: 1, content: "one" }],
      mapEdit: mapSummonGhostSplice,
      maxEdits: 50,
    })).toThrow("no changes");
  });
});
