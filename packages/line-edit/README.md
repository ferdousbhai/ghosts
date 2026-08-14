# @summonghost/line-edit

Pure line-anchored read and edit mechanics shared by `summon-ghost` and `ghost-build`.

The package provides:

- bounded, UTF-8-aware numbered reads;
- numbering for ranges selected by a consumer-owned reader;
- configurable SHA-256 snapshot versions and stale-version checks;
- generic edit mapping so each consumer keeps its existing tool-schema vocabulary;
- application against one original snapshot with bounds and overlap validation; and
- preservation of a UTF-8 BOM, the first newline style (`LF`, `CRLF`, or `CR`), and final-newline presence. Numbered display content omits the leading BOM so it cannot be copied into an interior replacement.

It deliberately contains no workspace paths, Cloudflare Computer integration, filesystem access, persistence, authorization, or application policy. Consumers validate their own schemas and own hashing, I/O, quotas, result vocabulary, and error exposure.

## Snapshot versions

Supply a full SHA-256 hex digest from the consumer's existing hashing boundary:

```ts
import {
  assertSnapshotVersion,
  snapshotVersion,
} from "@summonghost/line-edit";

const ghostbuildBase = snapshotVersion(sha256, {
  length: 24,
  letterCase: "upper",
});
const summonGhostVersion = snapshotVersion(sha256, {
  length: 32,
  letterCase: "lower",
});

assertSnapshotVersion(input.version, liveSha256, {
  length: 32,
  letterCase: "lower",
}, "File changed after it was read. Read the affected range again.");
```

`assertSnapshotVersion` compares the exact consumer-facing version, throws `StaleSnapshotError` on mismatch, and does not perform I/O or choose how a digest is computed.

## Numbered reads

Use `numberedRead` when the full stable snapshot is available and this package should enforce line and byte limits:

```ts
const range = numberedRead({
  content,
  offset: input.offset,
  limit: input.limit,
  maxLines: 2_000,
  maxBytes: 256 * 1024,
});
```

Use `numberReadContent(content, startLine)` when a consumer-owned reader has already selected and bounded a range. A terminal newline in such a chunk is retained as a numbered empty display line; `numberedRead` instead treats a terminal newline as the terminator of the final logical file line.

## Consumer operation mappings

`summon-ghost` can retain its splice vocabulary and 50-operation limit:

```ts
const applied = applyLineEdits({
  content,
  edits: input.edits,
  maxEdits: 50,
  mapEdit: (edit) => ({
    startLine: edit.startLine,
    deleteLines: edit.deleteLines,
    content: edit.content,
  }),
});
```

`ghost-build` can retain replacement ranges, after-line insertions, and its 100-operation limit:

```ts
const applied = applyLineEdits({
  content,
  edits: input.edits,
  maxEdits: 100,
  allowInsertionAtReplacementStart: true,
  mapEdit: (edit) => "afterLine" in edit
    ? { startLine: edit.afterLine + 1, deleteLines: 0, content: edit.content }
    : {
        startLine: edit.startLine,
        deleteLines: edit.endLine - edit.startLine + 1,
        content: edit.content,
      },
});
```

Every mapped `startLine` is one-indexed and addresses the original snapshot. An insertion uses `deleteLines: 0` and inserts immediately before `startLine`; therefore inserting after original line `n` maps to `startLine: n + 1`. Two insertions cannot share a boundary, replacements cannot overlap, and insertions cannot occur inside a replaced range. `allowInsertionAtReplacementStart` preserves `ghost-build`'s current ability to insert immediately before a replacement at the same boundary.

`applyLineEdits` rejects empty batches, per-operation empty splices, out-of-bounds ranges, overlapping operations, excessive batches, and edits that produce no content change. It returns the new content plus sorted change metadata; consumers map that metadata into their own tool-result vocabulary and perform persistence only after successful validation.
