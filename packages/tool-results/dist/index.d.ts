export declare const MODEL_TOOL_RESULT_MAX_CHARACTERS = 64000;
export declare const TOOL_RESULT_PAGE_DEFAULT_CHARACTERS = 40000;
export declare const TOOL_RESULT_PAGE_MAX_CHARACTERS = 60000;
export declare const TOOL_RESULT_SNAPSHOT_MAX_CHARACTERS = 4000000;
export declare const TOOL_RESULT_SNAPSHOT_TTL_MS: number;
export declare const TOOL_RESULT_SNAPSHOT_MAX_ENTRIES = 24;
export declare const TOOL_RESULT_STORE_MAX_CHARACTERS = 16000000;
export declare const TOOL_RESULT_BOUNDARY_RETAINED_MAX_CHARACTERS = 8000000;
export declare const TOOL_RESULT_TURN_MAX_CHARACTERS = 512000;
export declare const TOOL_ERROR_MAX_CHARACTERS = 8000;
export type ToolResultSnapshot = Readonly<{
    content: string;
    createdAt: number;
    handle: string;
    scope: string;
    toolCallId: string;
    toolName: string;
}>;
export type ToolResultPage = Readonly<{
    content: string;
    contentEnd: number;
    contentStart: number;
    nextContentStart?: number;
    previousContentStart?: number;
    totalCharacters: number;
}>;
export type StoredToolResultPage = ToolResultSnapshot & ToolResultPage;
/**
 * Synchronous snapshot retention supplied by the host. Methods are
 * intentionally synchronous because delivery exposes a handle only after
 * `set` succeeds. Async durable persistence is a host concern outside this
 * interface. A returned handle must never be rebound to different snapshot
 * data. `getPage` is the scoped redemption boundary and must return null for
 * a handle from another scope.
 */
export interface ToolResultStore {
    getPage(input: Readonly<{
        contentStart: number;
        handle: string;
        maxCharacters: number;
        scope: string;
    }>): StoredToolResultPage | null;
    set(input: Readonly<{
        content: string;
        scope: string;
        toolCallId: string;
        toolName: string;
    }>): ToolResultSnapshot | null;
    /** Keep one active scope's handles alive until its run settles. */
    pinScope?(scope: string): () => void;
    clear?(): void;
}
export type ToolResultPaginationDetails = Readonly<{
    handle: string;
    paginated: true;
    toolName: string;
    totalCharacters: number;
}>;
export type ToolResultOmissionDetails = Readonly<{
    omitted: true;
    paginated: false;
    reason: "retention_unavailable" | "turn_output_budget";
    toolName: string;
    totalCharacters: number;
}>;
export type ToolResultDelivery = Readonly<{
    details: ToolResultPaginationDetails | ToolResultOmissionDetails | undefined;
    text: string;
}>;
export type ToolResultBoundary = Readonly<{
    exhausted: boolean;
    /** True after this boundary produces a paginated, redeemable result. */
    hasReadableResult: boolean;
    /** Host-private scope that must accompany later handle redemption. */
    scope: string;
    error(error: unknown): string;
    deliver(input: Readonly<{
        content: string;
        toolCallId: string;
        toolName: string;
    }>): ToolResultDelivery;
}>;
/** Replace unpaired UTF-16 surrogates without changing valid Unicode text. */
export declare function toWellFormedText(value: string): string;
/** Slice by UTF-16 offsets while never splitting a valid surrogate pair. */
export declare function sliceTextPage(value: string, contentStart: number, maxCharacters: number): Readonly<{
    content: string;
    contentEnd: number;
    contentStart: number;
}>;
/** Return one immutable offset page from an exact snapshot. */
export declare function toolResultPage(snapshot: ToolResultSnapshot, contentStart?: number, maxCharacters?: number): ToolResultPage;
export declare function formatToolResultPage(snapshot: ToolResultSnapshot, contentStart?: number, maxCharacters?: number): string;
export declare function formatStoredToolResultPage(page: StoredToolResultPage): string;
/**
 * Bound model-facing tool output and retain oversized exact results in the
 * host's private store. Scope values are capabilities and must stay private.
 */
export declare function createToolResultBoundary(store: ToolResultStore, maximumTurnCharacters?: number, scope?: string, maximumRetainedCharacters?: number): ToolResultBoundary;
export declare function boundedToolErrorMessage(error: unknown): string;
/** A bounded, expiring, process-local in-memory store; it is not durable. */
export declare function createInMemoryToolResultStore(maximumCharacters?: number, maximumTotalCharacters?: number): ToolResultStore;
