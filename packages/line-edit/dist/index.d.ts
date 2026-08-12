export type SnapshotVersionFormat = Readonly<{
    /** Number of leading SHA-256 hexadecimal characters to expose. */
    length: number;
    letterCase?: "lower" | "upper";
}>;
export declare class StaleSnapshotError extends Error {
    readonly name = "StaleSnapshotError";
    constructor(message?: string);
}
/** Format a caller-supplied SHA-256 digest as a consumer-specific snapshot version. */
export declare function snapshotVersion(sha256: string, format: SnapshotVersionFormat): string;
/** Verify an edit version against the live content digest and return the live version. */
export declare function assertSnapshotVersion(expectedVersion: string, liveSha256: string, format: SnapshotVersionFormat, staleMessage?: string): string;
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
export declare function numberedRead(options: NumberedReadOptions): NumberedReadResult;
/**
 * Number an already-selected read chunk. Unlike numberedRead, this preserves a
 * trailing empty display line because the caller, rather than this package,
 * owns range pagination.
 */
export declare function numberReadContent(content: string, startLine?: number): string;
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
/** Apply mapped line splices against one original snapshot, never incrementally. */
export declare function applyLineEdits<Operation>(options: ApplyLineEditsOptions<Operation>): AppliedLineEdits;
