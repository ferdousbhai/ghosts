import { z } from "zod";
export declare const MAX_RELATIONSHIP_MEMORY_LENGTH = 5000;
export declare const MAX_MEMORY_LINE_LENGTH = 1000;
export declare const memoryLineSchema: z.ZodString;
/** Canonical model-facing input for adding one relationship memory. */
export declare const rememberInputSchema: z.ZodObject<{
    content: z.ZodString;
}, z.core.$strict>;
/** Canonical model-facing input for removing or correcting one exact passage. */
export declare const forgetInputSchema: z.ZodObject<{
    memory: z.ZodString;
    correction: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
/** Pure append contract. It contains no application scope. */
export declare const relationshipMemoryAppendSchema: z.ZodObject<{
    content: z.ZodString;
}, z.core.$strict>;
/** Pure exact-text replacement contract. An empty newText removes oldText. */
export declare const relationshipMemoryReplaceSchema: z.ZodObject<{
    oldText: z.ZodString;
    newText: z.ZodString;
}, z.core.$strict>;
/** Repository/workflow mutation union. */
export declare const relationshipMemoryMutationSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    content: z.ZodString;
    kind: z.ZodLiteral<"append">;
}, z.core.$strict>, z.ZodObject<{
    oldText: z.ZodString;
    newText: z.ZodString;
    kind: z.ZodLiteral<"replace">;
}, z.core.$strict>], "kind">;
/** Strict runtime contract for workflow state transitions. */
export declare const relationshipMemoryOperationSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"mutate">;
    mutation: z.ZodDiscriminatedUnion<[z.ZodObject<{
        content: z.ZodString;
        kind: z.ZodLiteral<"append">;
    }, z.core.$strict>, z.ZodObject<{
        oldText: z.ZodString;
        newText: z.ZodString;
        kind: z.ZodLiteral<"replace">;
    }, z.core.$strict>], "kind">;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"compact">;
}, z.core.$strict>], "kind">;
export type ParsedMemory = string;
export type RememberInput = z.infer<typeof rememberInputSchema>;
export type ForgetInput = z.infer<typeof forgetInputSchema>;
export type RelationshipMemoryAppend = z.infer<typeof relationshipMemoryAppendSchema>;
export type RelationshipMemoryReplace = z.infer<typeof relationshipMemoryReplaceSchema>;
export type RelationshipMemoryMutation = z.infer<typeof relationshipMemoryMutationSchema>;
export type RelationshipMemoryDocument = Readonly<{
    content: string;
    revision: number;
}>;
export type RelationshipMemoryMutationResult = Readonly<{
    content: string;
    changed: boolean;
}>;
export type RelationshipMemoryOperation = Readonly<{
    kind: "mutate";
    mutation: RelationshipMemoryMutation;
}> | Readonly<{
    kind: "compact";
}>;
export type RelationshipMemoryCommitInput = Readonly<{
    operationId: string;
    expectedRevision: number;
    content: string;
    compacted: boolean;
}>;
export type RelationshipMemoryCommitResult = Readonly<{
    status: "committed";
    document: RelationshipMemoryDocument;
}> | Readonly<{
    status: "conflict";
}>;
/**
 * Consumer-supplied persistence port. Implementations own identity, scope,
 * authorization, storage, and transaction boundaries.
 */
export interface RelationshipMemoryRepository {
    read(): Promise<RelationshipMemoryDocument>;
    wasOperationApplied(operationId: string): Promise<boolean>;
    commit(input: RelationshipMemoryCommitInput): Promise<RelationshipMemoryCommitResult>;
}
/** Consumer-supplied model port. Provider selection and billing stay outside. */
export type RelationshipMemoryCompactor = (input: Readonly<{
    document: RelationshipMemoryDocument;
    sourceContent: string;
    maximumLength: number;
}>) => Promise<string>;
export type RelationshipMemoryExecutionResult = Readonly<{
    status: "applied" | "unchanged" | "already_applied";
    document: RelationshipMemoryDocument;
    compacted: boolean;
    attempts: number;
}>;
export declare class RelationshipMemoryConflictError extends Error {
    readonly attempts: number;
    readonly code: "relationship_memory_conflict";
    constructor(attempts: number);
}
export declare class RelationshipMemoryCapacityError extends Error {
    readonly currentLength: number;
    readonly attemptedLength: number;
    readonly code: "relationship_memory_capacity";
    readonly maxLength = 5000;
    readonly requiredReduction: number;
    constructor(currentLength: number, attemptedLength: number);
}
export declare function normalizeMemoryLine(value: string): string;
export declare function parseMemoryBlock(content: string | null | undefined): ParsedMemory[];
export declare function mergeMemoryEntries(current: ParsedMemory[], next: ParsedMemory[]): ParsedMemory[];
export declare function formatMemoryLines(lines: readonly string[]): string;
export declare function normalizeRelationshipMemoryDocument(content: string): string;
export declare function shouldCompactRelationshipMemory(content: string): boolean;
export declare function assertRelationshipMemoryLength(content: string): void;
export declare function assertExpectedRelationshipMemoryRevision(document: Pick<RelationshipMemoryDocument, "revision">, expected: number): void;
export declare function containsExactMemoryBlock(content: string, block: string): boolean;
export declare function countMemoryOccurrences(content: string, value: string): number;
/** Apply append semantics without persistence or application policy. */
export declare function appendRelationshipMemory(currentContent: string, append: RelationshipMemoryAppend): RelationshipMemoryMutationResult;
/** Apply unique exact-text replacement without persistence or app policy. */
export declare function replaceRelationshipMemory(currentContent: string, replacement: RelationshipMemoryReplace, options?: Readonly<{
    allowAlreadyApplied?: boolean;
}>): RelationshipMemoryMutationResult;
export declare function applyRelationshipMemoryMutation(currentContent: string, mutation: RelationshipMemoryMutation, options?: Readonly<{
    allowAlreadyApplied?: boolean;
}>): RelationshipMemoryMutationResult;
export declare function formatRelationshipMemoryContext(content: string): string | null;
export declare function validateRelationshipMemoryCompaction(input: Readonly<{
    sourceContent: string;
    compactedContent: string;
}>): string;
/**
 * Execute the repository-neutral relationship-memory state machine.
 *
 * Consumers own identity/scope, authorization, persistence, billing, model
 * execution, background dispatch, and telemetry. This function owns mutation
 * semantics, replay detection, compaction validation, and optimistic retries.
 */
export declare function executeRelationshipMemoryOperation(input: Readonly<{
    repository: RelationshipMemoryRepository;
    operationId: string;
    operation: RelationshipMemoryOperation;
    compactor?: RelationshipMemoryCompactor;
    maxAttempts?: number;
}>): Promise<RelationshipMemoryExecutionResult>;
