export type SnapshotVersionFormat = Readonly<{
  /** Number of leading SHA-256 hexadecimal characters to expose. */
  length: number;
  letterCase?: "lower" | "upper";
}>;

export class StaleSnapshotError extends Error {
  readonly name = "StaleSnapshotError";

  constructor(message = "The content changed after this snapshot was read.") {
    super(message);
  }
}

/** Format a caller-supplied SHA-256 digest as a consumer-specific snapshot version. */
export function snapshotVersion(
  sha256: string,
  format: SnapshotVersionFormat,
): string {
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error("A snapshot version requires a SHA-256 hexadecimal digest.");
  }
  if (
    !Number.isSafeInteger(format.length) ||
    format.length < 1 ||
    format.length > 64
  ) {
    throw new Error("Snapshot version length must be an integer from 1 to 64.");
  }

  if (
    format.letterCase !== undefined &&
    format.letterCase !== "lower" &&
    format.letterCase !== "upper"
  ) {
    throw new Error('Snapshot version letterCase must be "lower" or "upper".');
  }

  const version = sha256.slice(0, format.length);
  return format.letterCase === "upper"
    ? version.toUpperCase()
    : version.toLowerCase();
}

/** Verify an edit version against the live content digest and return the live version. */
export function assertSnapshotVersion(
  expectedVersion: string,
  liveSha256: string,
  format: SnapshotVersionFormat,
  staleMessage?: string,
): string {
  const liveVersion = snapshotVersion(liveSha256, format);
  if (expectedVersion !== liveVersion) {
    throw new StaleSnapshotError(staleMessage);
  }
  return liveVersion;
}

export type NumberedReadOptions = Readonly<{
  content: string;
  offset?: number;
  limit?: number;
  maxLines: number;
  maxBytes: number;
}>;

export type NumberedReadResult = Readonly<{
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  nextOffset?: number;
}>;

/**
 * Number a complete snapshot with bounded, one-indexed pagination.
 * A terminal newline terminates the last logical line; it is not an extra line.
 */
export function numberedRead(options: NumberedReadOptions): NumberedReadResult {
  assertPositiveInteger(options.maxLines, "maxLines");
  assertPositiveInteger(options.maxBytes, "maxBytes");
  const offset = options.offset ?? 1;
  assertPositiveInteger(offset, "offset");
  if (options.limit !== undefined) {
    assertPositiveInteger(options.limit, "limit");
  }

  const snapshotContent = options.content.startsWith("\uFEFF")
    ? options.content.slice(1)
    : options.content;
  const lines = splitLogicalText(snapshotContent).lines;
  if (lines.length === 0) {
    if (offset !== 1) {
      throw new Error(`Offset ${offset} is beyond end of content (0 lines).`);
    }
    return {
      content: "",
      startLine: 1,
      endLine: 0,
      totalLines: 0,
      truncated: false,
    };
  }
  if (offset > lines.length) {
    throw new Error(
      `Offset ${offset} is beyond end of content (${lines.length} lines).`,
    );
  }

  const lineLimit = Math.min(options.limit ?? options.maxLines, options.maxLines);
  const selected: string[] = [];
  let selectedBytes = 0;
  for (
    let lineIndex = offset - 1;
    lineIndex < lines.length && selected.length < lineLimit;
    lineIndex += 1
  ) {
    const rendered = `${lineIndex + 1}:${lines[lineIndex]}`;
    const renderedBytes = utf8Length(rendered) + (selected.length === 0 ? 0 : 1);
    if (selected.length === 0 && renderedBytes > options.maxBytes) {
      throw new Error(
        `Line ${lineIndex + 1} exceeds the ${options.maxBytes}-byte read cap.`,
      );
    }
    if (selectedBytes + renderedBytes > options.maxBytes) break;
    selected.push(rendered);
    selectedBytes += renderedBytes;
  }

  const endLine = offset + selected.length - 1;
  const truncated = endLine < lines.length;
  return {
    content: selected.join("\n"),
    startLine: offset,
    endLine,
    totalLines: lines.length,
    truncated,
    ...(truncated ? { nextOffset: endLine + 1 } : {}),
  };
}

/**
 * Number an already-selected read chunk. Unlike numberedRead, this preserves a
 * trailing empty display line because the caller, rather than this package,
 * owns range pagination.
 */
export function numberReadContent(content: string, startLine = 1): string {
  assertPositiveInteger(startLine, "startLine");
  const displayContent = startLine === 1 && content.startsWith("\uFEFF")
    ? content.slice(1)
    : content;
  if (displayContent.length === 0) return "";
  return normalizeToLf(displayContent)
    .split("\n")
    .map((line, index) => `${startLine + index}:${line}`)
    .join("\n");
}

export type MappedLineEdit = Readonly<{
  /** One-indexed original line before which this splice starts. */
  startLine: number;
  /** Number of original logical lines removed by this splice. */
  deleteLines: number;
  /** Unnumbered replacement content. */
  content: string;
}>;

export type ApplyLineEditsOptions<Operation> = Readonly<{
  content: string;
  edits: readonly Operation[];
  mapEdit: (edit: Operation, index: number) => MappedLineEdit;
  maxEdits: number;
  /**
   * Permit an insertion immediately before a replacement beginning at the
   * same original line. Insertions inside a replacement remain invalid.
   */
  allowInsertionAtReplacementStart?: boolean;
}>;

export type AppliedLineEdit = Readonly<{
  operationIndex: number;
  startLine: number;
  deletedLines: number;
  insertedLines: number;
}>;

export type AppliedLineEdits = Readonly<{
  content: string;
  editsApplied: number;
  firstChangedLine: number;
  changes: readonly AppliedLineEdit[];
}>;

type PreparedLineEdit = MappedLineEdit & {
  operationIndex: number;
  index: number;
  insertLines: string[];
};

/** Apply mapped line splices against one original snapshot, never incrementally. */
export function applyLineEdits<Operation>(
  options: ApplyLineEditsOptions<Operation>,
): AppliedLineEdits {
  assertPositiveInteger(options.maxEdits, "maxEdits");
  if (options.edits.length === 0) {
    throw new Error("edits must contain at least one line operation.");
  }
  if (options.edits.length > options.maxEdits) {
    throw new Error(
      `Apply at most ${options.maxEdits} line operations in one edit.`,
    );
  }

  const parsed = parseText(options.content);
  const prepared = options.edits.map((edit, operationIndex) =>
    prepareEdit(
      options.mapEdit(edit, operationIndex),
      operationIndex,
      parsed.lines.length,
    )
  );
  assertEditsDoNotOverlap(
    prepared,
    options.allowInsertionAtReplacementStart ?? false,
  );

  const nextLines = [...parsed.lines];
  for (const edit of [...prepared].sort(compareForApplication)) {
    nextLines.splice(edit.index, edit.deleteLines, ...edit.insertLines);
  }

  const nextBody = nextLines.join(parsed.lineEnding) +
    (parsed.hasFinalNewline && nextLines.length > 0 ? parsed.lineEnding : "");
  const nextContent = parsed.bom + nextBody;
  if (nextContent === options.content) {
    throw new Error("The line edit produced no changes.");
  }

  const changes = [...prepared]
    .sort((left, right) =>
      left.startLine - right.startLine || left.operationIndex - right.operationIndex
    )
    .map((edit) => ({
      operationIndex: edit.operationIndex,
      startLine: edit.startLine,
      deletedLines: edit.deleteLines,
      insertedLines: edit.insertLines.length,
    }));
  return {
    content: nextContent,
    editsApplied: prepared.length,
    firstChangedLine: changes[0]!.startLine,
    changes,
  };
}

function prepareEdit(
  edit: MappedLineEdit,
  operationIndex: number,
  totalLines: number,
): PreparedLineEdit {
  assertPositiveInteger(edit.startLine, `edits[${operationIndex}].startLine`);
  if (!Number.isSafeInteger(edit.deleteLines) || edit.deleteLines < 0) {
    throw new Error(
      `edits[${operationIndex}].deleteLines must be a non-negative integer.`,
    );
  }
  if (typeof edit.content !== "string") {
    throw new Error(`edits[${operationIndex}].content must be a string.`);
  }
  if (edit.deleteLines === 0 && edit.content.length === 0) {
    throw new Error(`edits[${operationIndex}] does not delete or insert content.`);
  }

  const lastDeletedLine = edit.startLine + edit.deleteLines - 1;
  if (edit.deleteLines === 0) {
    if (edit.startLine > totalLines + 1) {
      throw new Error(
        `edits[${operationIndex}].startLine ${edit.startLine} is beyond insertion line ${totalLines + 1}.`,
      );
    }
  } else if (
    edit.startLine > totalLines ||
    lastDeletedLine > totalLines ||
    !Number.isSafeInteger(lastDeletedLine)
  ) {
    throw new Error(
      `edits[${operationIndex}] deletes lines ${edit.startLine}-${lastDeletedLine}, but the content has ${totalLines} line(s).`,
    );
  }

  return {
    ...edit,
    operationIndex,
    index: edit.startLine - 1,
    insertLines: splitLogicalText(edit.content).lines,
  };
}

function assertEditsDoNotOverlap(
  edits: readonly PreparedLineEdit[],
  allowInsertionAtReplacementStart: boolean,
): void {
  for (let leftIndex = 0; leftIndex < edits.length; leftIndex += 1) {
    const left = edits[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < edits.length; rightIndex += 1) {
      const right = edits[rightIndex]!;
      if (editsConflict(left, right, allowInsertionAtReplacementStart)) {
        throw new Error(
          `edits[${left.operationIndex}] and edits[${right.operationIndex}] overlap or share an insertion point.`,
        );
      }
    }
  }
}

function editsConflict(
  left: PreparedLineEdit,
  right: PreparedLineEdit,
  allowInsertionAtReplacementStart: boolean,
): boolean {
  const leftIsInsertion = left.deleteLines === 0;
  const rightIsInsertion = right.deleteLines === 0;
  if (leftIsInsertion && rightIsInsertion) return left.index === right.index;

  if (!leftIsInsertion && !rightIsInsertion) {
    return left.index < right.index + right.deleteLines &&
      right.index < left.index + left.deleteLines;
  }

  const insertion = leftIsInsertion ? left : right;
  const replacement = leftIsInsertion ? right : left;
  const atReplacementStart = insertion.index === replacement.index;
  return (
    insertion.index > replacement.index &&
    insertion.index < replacement.index + replacement.deleteLines
  ) || (atReplacementStart && !allowInsertionAtReplacementStart);
}

function compareForApplication(
  left: PreparedLineEdit,
  right: PreparedLineEdit,
): number {
  if (left.index !== right.index) return right.index - left.index;
  // Replace first, then insert at the same boundary so the insertion remains
  // immediately before the replacement output.
  return right.deleteLines - left.deleteLines;
}

type ParsedText = Readonly<{
  bom: string;
  lines: string[];
  lineEnding: "\n" | "\r\n" | "\r";
  hasFinalNewline: boolean;
}>;

function parseText(content: string): ParsedText {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? content.slice(1) : content;
  const parsed = splitLogicalText(body);
  return {
    bom,
    lines: parsed.lines,
    lineEnding: detectLineEnding(body),
    hasFinalNewline: parsed.hasFinalNewline,
  };
}

function splitLogicalText(content: string): {
  lines: string[];
  hasFinalNewline: boolean;
} {
  const normalized = normalizeToLf(content);
  if (normalized.length === 0) {
    return { lines: [], hasFinalNewline: false };
  }
  const hasFinalNewline = normalized.endsWith("\n");
  const withoutFinalNewline = hasFinalNewline
    ? normalized.slice(0, -1)
    : normalized;
  return {
    lines: withoutFinalNewline.length > 0
      ? withoutFinalNewline.split("\n")
      : [""],
    hasFinalNewline,
  };
}

function detectLineEnding(content: string): "\n" | "\r\n" | "\r" {
  return /\r\n|\n|\r/.exec(content)?.[0] as "\n" | "\r\n" | "\r" | undefined ??
    "\n";
}

function normalizeToLf(content: string): string {
  return content.replace(/\r\n|\r/g, "\n");
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
