import { z } from "zod";
export const MAX_RELATIONSHIP_MEMORY_LENGTH = 5_000;
export const MAX_MEMORY_LINE_LENGTH = 1_000;
export const memoryLineSchema = z
    .string()
    .trim()
    .min(1)
    .max(MAX_MEMORY_LINE_LENGTH);
/** Canonical model-facing input for adding one relationship memory. */
export const rememberInputSchema = z.strictObject({
    content: memoryLineSchema
        .regex(/^[^\r\n]*$/, "content must be one line")
        .describe("One concise, standalone fact to save to relationship memory."),
});
/** Canonical model-facing input for removing or correcting one exact passage. */
export const forgetInputSchema = z.strictObject({
    memory: z
        .string()
        .trim()
        .min(1)
        .max(MAX_RELATIONSHIP_MEMORY_LENGTH)
        .describe("A short, unique, exact passage from current relationship memory to remove or correct."),
    correction: memoryLineSchema
        .regex(/^[^\r\n]*$/, "correction must be one line")
        .optional()
        .describe("Corrected standalone fact. Omit to remove the selected passage."),
});
/** Pure append contract. It contains no application scope. */
export const relationshipMemoryAppendSchema = z.strictObject({
    content: z
        .string()
        .max(MAX_RELATIONSHIP_MEMORY_LENGTH)
        .refine((value) => value.trim().length > 0, {
        message: "content is required",
    }),
});
/** Pure exact-text replacement contract. An empty newText removes oldText. */
export const relationshipMemoryReplaceSchema = z.strictObject({
    oldText: z
        .string()
        .max(MAX_RELATIONSHIP_MEMORY_LENGTH)
        .refine((value) => value.trim().length > 0, {
        message: "oldText is required",
    }),
    newText: z.string().max(MAX_RELATIONSHIP_MEMORY_LENGTH),
});
/** Repository/workflow mutation union. */
export const relationshipMemoryMutationSchema = z.discriminatedUnion("kind", [
    relationshipMemoryAppendSchema.extend({ kind: z.literal("append") }),
    relationshipMemoryReplaceSchema.extend({ kind: z.literal("replace") }),
]);
/** Strict runtime contract for workflow state transitions. */
export const relationshipMemoryOperationSchema = z.discriminatedUnion("kind", [
    z.strictObject({
        kind: z.literal("mutate"),
        mutation: relationshipMemoryMutationSchema,
    }),
    z.strictObject({ kind: z.literal("compact") }),
]);
export class RelationshipMemoryConflictError extends Error {
    attempts;
    code = "relationship_memory_conflict";
    constructor(attempts) {
        super(`Relationship memory changed concurrently after ${attempts} attempts`);
        this.attempts = attempts;
        this.name = "RelationshipMemoryConflictError";
    }
}
export class RelationshipMemoryCapacityError extends Error {
    currentLength;
    attemptedLength;
    code = "relationship_memory_capacity";
    maxLength = MAX_RELATIONSHIP_MEMORY_LENGTH;
    requiredReduction;
    constructor(currentLength, attemptedLength) {
        const requiredReduction = Math.max(1, attemptedLength - MAX_RELATIONSHIP_MEMORY_LENGTH);
        super(`Relationship memory needs ${requiredReduction} fewer characters before this change can be saved`);
        this.currentLength = currentLength;
        this.attemptedLength = attemptedLength;
        this.name = "RelationshipMemoryCapacityError";
        this.requiredReduction = requiredReduction;
    }
}
export function normalizeMemoryLine(value) {
    return value.replace(/\s+/g, " ").trim();
}
export function parseMemoryBlock(content) {
    const trimmed = content?.trim();
    if (!trimmed)
        return [];
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch (cause) {
        if (trimmed.startsWith("[")) {
            throw new Error("Invalid legacy JSON memory block", { cause });
        }
        // Plain text is the normal writable-context format.
    }
    if (Array.isArray(parsed)) {
        return mergeMemoryEntries(parsed.map((item, index) => {
            const line = parseJsonMemoryItem(item);
            if (!line) {
                throw new Error(`Invalid legacy JSON memory item at index ${index}`);
            }
            return line;
        }), []);
    }
    return mergeMemoryEntries(trimmed
        .split(/\r?\n/)
        .map((rawLine) => rawLine
        .trim()
        .replace(/^[-*]\s+/, "")
        .trim())
        .filter((line) => line && !line.startsWith("#")), []);
}
export function mergeMemoryEntries(current, next) {
    const merged = new Map();
    for (const line of [...current, ...next]) {
        const normalized = normalizeMemoryLine(line);
        if (!normalized)
            continue;
        merged.set(normalized.toLowerCase(), normalized);
    }
    return [...merged.values()];
}
export function formatMemoryLines(lines) {
    return lines.map((line) => `- ${normalizeMemoryLine(line)}`).join("\n");
}
export function normalizeRelationshipMemoryDocument(content) {
    return content
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .trim();
}
export function shouldCompactRelationshipMemory(content) {
    return content.length > MAX_RELATIONSHIP_MEMORY_LENGTH;
}
export function assertRelationshipMemoryLength(content) {
    if (content.length > MAX_RELATIONSHIP_MEMORY_LENGTH) {
        throw new Error(`Relationship memory must be ${MAX_RELATIONSHIP_MEMORY_LENGTH} characters or fewer`);
    }
}
export function assertExpectedRelationshipMemoryRevision(document, expected) {
    if (document.revision !== expected) {
        throw new Error(`Memory revision conflict: expected ${expected}, actual ${document.revision}; read memory and retry`);
    }
}
export function containsExactMemoryBlock(content, block) {
    if (!block)
        return false;
    let offset = 0;
    while (true) {
        const index = content.indexOf(block, offset);
        if (index < 0)
            return false;
        const startsAtBoundary = index === 0 || content[index - 1] === "\n";
        const end = index + block.length;
        const endsAtBoundary = end === content.length || content[end] === "\n";
        if (startsAtBoundary && endsAtBoundary)
            return true;
        offset = index + block.length;
    }
}
export function countMemoryOccurrences(content, value) {
    if (!value)
        return 0;
    let count = 0;
    let offset = 0;
    while (true) {
        const index = content.indexOf(value, offset);
        if (index < 0)
            return count;
        count += 1;
        offset = index + 1;
    }
}
/** Apply append semantics without persistence or application policy. */
export function appendRelationshipMemory(currentContent, append) {
    const current = normalizeRelationshipMemoryDocument(currentContent);
    const appended = normalizeRelationshipMemoryDocument(append.content);
    if (!appended)
        throw new Error("Memory content is required");
    if (containsExactMemoryBlock(current, appended)) {
        return { content: current, changed: false };
    }
    return {
        content: current ? `${current}\n${appended}` : appended,
        changed: true,
    };
}
/** Apply unique exact-text replacement without persistence or app policy. */
export function replaceRelationshipMemory(currentContent, replacement, options = {}) {
    const current = normalizeRelationshipMemoryDocument(currentContent);
    const oldText = normalizeLineEndings(replacement.oldText).trim();
    if (!oldText)
        throw new Error("old_text is required");
    const occurrences = countMemoryOccurrences(current, oldText);
    if (occurrences === 0) {
        const newText = normalizeLineEndings(replacement.newText).trim();
        const alreadyApplied = options.allowAlreadyApplied === true &&
            (!newText || countMemoryOccurrences(current, newText) > 0);
        if (alreadyApplied)
            return { content: current, changed: false };
        throw new Error("Memory text was not found; read memory and retry");
    }
    if (occurrences > 1) {
        throw new Error("Memory text is not unique; use a larger exact selection");
    }
    const newText = normalizeLineEndings(replacement.newText).trim();
    const content = normalizeRelationshipMemoryDocument(current.replace(oldText, newText));
    return { content, changed: content !== current };
}
export function applyRelationshipMemoryMutation(currentContent, mutation, options = {}) {
    return mutation.kind === "append"
        ? appendRelationshipMemory(currentContent, mutation)
        : replaceRelationshipMemory(currentContent, mutation, options);
}
export function formatRelationshipMemoryContext(content) {
    const trimmed = content.trim();
    if (!trimmed)
        return null;
    assertRelationshipMemoryLength(trimmed);
    return [
        "<relationship_memory>",
        escapeXml(trimmed),
        "</relationship_memory>",
    ].join("\n");
}
export function validateRelationshipMemoryCompaction(input) {
    const sourceContent = normalizeRelationshipMemoryDocument(input.sourceContent);
    if (!sourceContent) {
        throw new Error("Cannot compact an empty relationship-memory document");
    }
    const compactedContent = normalizeRelationshipMemoryDocument(input.compactedContent);
    if (!compactedContent) {
        throw new Error("Relationship-memory compaction returned an empty document");
    }
    if (shouldCompactRelationshipMemory(compactedContent)) {
        throw new Error(`Relationship-memory compaction must return ${MAX_RELATIONSHIP_MEMORY_LENGTH} characters or fewer`);
    }
    if (compactedContent.length >= sourceContent.length) {
        throw new Error("Relationship-memory compaction did not shorten the document");
    }
    return compactedContent;
}
/**
 * Execute the repository-neutral relationship-memory state machine.
 *
 * Consumers own identity/scope, authorization, persistence, billing, model
 * execution, background dispatch, and telemetry. This function owns mutation
 * semantics, replay detection, compaction validation, and optimistic retries.
 */
export async function executeRelationshipMemoryOperation(input) {
    const operationId = input.operationId.trim();
    if (!operationId) {
        throw new Error("Relationship-memory operation ID is required");
    }
    const maxAttempts = input.maxAttempts ?? 4;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
        throw new Error("Relationship-memory max attempts must be a positive integer");
    }
    const operation = relationshipMemoryOperationSchema.parse(input.operation);
    const mutation = operation.kind === "mutate" ? operation.mutation : null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (await input.repository.wasOperationApplied(operationId)) {
            return {
                status: "already_applied",
                document: await input.repository.read(),
                compacted: false,
                attempts: attempt,
            };
        }
        const document = await input.repository.read();
        // Close the check/read race before interpreting an already-mutated snapshot.
        if (await input.repository.wasOperationApplied(operationId)) {
            return {
                status: "already_applied",
                document: await input.repository.read(),
                compacted: false,
                attempts: attempt,
            };
        }
        const mutationResult = mutation
            ? applyRelationshipMemoryMutation(document.content, mutation)
            : { content: document.content, changed: false };
        let content = mutationResult.content;
        let compacted = false;
        if (shouldCompactRelationshipMemory(content)) {
            if (!input.compactor) {
                throw new RelationshipMemoryCapacityError(document.content.length, content.length);
            }
            content = validateRelationshipMemoryCompaction({
                sourceContent: content,
                compactedContent: await input.compactor({
                    document,
                    sourceContent: content,
                    maximumLength: MAX_RELATIONSHIP_MEMORY_LENGTH,
                }),
            });
            compacted = true;
        }
        if (!mutationResult.changed && !compacted) {
            if (await input.repository.wasOperationApplied(operationId)) {
                return {
                    status: "already_applied",
                    document: await input.repository.read(),
                    compacted: false,
                    attempts: attempt,
                };
            }
            return {
                status: "unchanged",
                document,
                compacted: false,
                attempts: attempt,
            };
        }
        const commit = await input.repository.commit({
            operationId,
            expectedRevision: document.revision,
            content,
            compacted,
        });
        if (commit.status === "committed") {
            return {
                status: "applied",
                document: commit.document,
                compacted,
                attempts: attempt,
            };
        }
    }
    if (await input.repository.wasOperationApplied(operationId)) {
        return {
            status: "already_applied",
            document: await input.repository.read(),
            compacted: false,
            attempts: maxAttempts,
        };
    }
    throw new RelationshipMemoryConflictError(maxAttempts);
}
function parseJsonMemoryItem(item) {
    if (typeof item === "string")
        return normalizeMemoryLine(item);
    const objectEntry = z
        .object({
        key: z.string().trim().min(1).optional(),
        value: z.string().trim().min(1),
    })
        .safeParse(item);
    if (!objectEntry.success)
        return null;
    return normalizeMemoryLine(objectEntry.data.key
        ? `${objectEntry.data.key}: ${objectEntry.data.value}`
        : objectEntry.data.value);
}
function normalizeLineEndings(content) {
    return content.replace(/\r\n?/g, "\n");
}
function escapeXml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
