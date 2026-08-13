import { describe, expect, it, vi } from "vitest";
import {
  MAX_RELATIONSHIP_MEMORY_LENGTH,
  RelationshipMemoryCapacityError,
  RelationshipMemoryConflictError,
  appendRelationshipMemory,
  applyRelationshipMemoryMutation,
  assertExpectedRelationshipMemoryRevision,
  containsExactMemoryBlock,
  countMemoryOccurrences,
  executeRelationshipMemoryOperation,
  forgetInputSchema,
  formatMemoryLines,
  formatRelationshipMemoryContext,
  mergeMemoryEntries,
  normalizeRelationshipMemoryDocument,
  parseMemoryBlock,
  relationshipMemoryAppendSchema,
  relationshipMemoryMutationSchema,
  relationshipMemoryReplaceSchema,
  rememberInputSchema,
  replaceRelationshipMemory,
  shouldCompactRelationshipMemory,
  validateRelationshipMemoryCompaction,
  type RelationshipMemoryCommitInput,
  type RelationshipMemoryDocument,
  type RelationshipMemoryRepository,
} from "./index.js";

describe("@summonghost/memory-contracts", () => {
  it("standardizes strict model-facing remember and forget schemas", () => {
    expect(rememberInputSchema.parse({ content: " Prefers concise replies. " }))
      .toEqual({ content: "Prefers concise replies." });
    expect(rememberInputSchema.safeParse({ content: "" }).success).toBe(false);
    expect(rememberInputSchema.safeParse({ content: "two\nmemories" }).success)
      .toBe(false);
    expect(rememberInputSchema.safeParse({ content: "Valid", audience: "private" }).success)
      .toBe(false);

    expect(forgetInputSchema.parse({ memory: " Old preference. " }))
      .toEqual({ memory: "Old preference." });
    expect(forgetInputSchema.parse({
      memory: "Old preference.",
      correction: " Current preference. ",
    })).toEqual({
      memory: "Old preference.",
      correction: "Current preference.",
    });
    expect(forgetInputSchema.safeParse({ memory: "" }).success).toBe(false);
    expect(forgetInputSchema.safeParse({ memory: "Old", correction: "" }).success)
      .toBe(false);
    expect(forgetInputSchema.safeParse({ memory: "Old", persist: true }).success)
      .toBe(false);
  });

  it("keeps append and replace workflow contracts strict and app-neutral", () => {
    const maximumLength = "x".repeat(MAX_RELATIONSHIP_MEMORY_LENGTH);
    const oversized = `${maximumLength}x`;

    expect(relationshipMemoryAppendSchema.parse({
      content: "I am Canadian.",
    })).toEqual({ content: "I am Canadian." });
    expect(relationshipMemoryReplaceSchema.parse({
      oldText: "tea",
      newText: "coffee",
    })).toEqual({ oldText: "tea", newText: "coffee" });
    expect(relationshipMemoryMutationSchema.safeParse({
      kind: "replace",
      oldText: "tea",
      newText: "coffee",
    }).success).toBe(true);
    expect(relationshipMemoryMutationSchema.safeParse({
      kind: "append",
      content: "I am Canadian.",
      ownerUserId: "user-1",
    }).success).toBe(false);
    expect(relationshipMemoryAppendSchema.safeParse({ content: "  " }).success)
      .toBe(false);
    expect(relationshipMemoryAppendSchema.safeParse({
      content: maximumLength,
    }).success).toBe(true);
    expect(relationshipMemoryAppendSchema.safeParse({ content: oversized }).success)
      .toBe(false);
    expect(relationshipMemoryReplaceSchema.safeParse({
      oldText: "",
      newText: "coffee",
    }).success).toBe(false);
    expect(relationshipMemoryReplaceSchema.safeParse({
      oldText: maximumLength,
      newText: maximumLength,
    }).success).toBe(true);
    expect(relationshipMemoryReplaceSchema.safeParse({
      oldText: oversized,
      newText: "",
    }).success).toBe(false);
    expect(relationshipMemoryReplaceSchema.safeParse({
      oldText: "tea",
      newText: oversized,
    }).success).toBe(false);
  });

  it("parses plain text and legacy JSON memory blocks", () => {
    expect(parseMemoryBlock("# Memory\n- Likes tea.\n* Uses metric units."))
      .toEqual(["Likes tea.", "Uses metric units."]);
    expect(parseMemoryBlock(
      JSON.stringify(["Likes tea.", { key: "Units", value: "metric" }]),
    )).toEqual(["Likes tea.", "Units: metric"]);
  });

  it("rejects malformed legacy JSON without dropping corrupt entries", () => {
    expect(() => parseMemoryBlock(
      JSON.stringify(["Likes tea.", { invalid: true }]),
    )).toThrow("Invalid legacy JSON memory item at index 1");
    expect(() => parseMemoryBlock('["Likes tea."')).toThrow(
      "Invalid legacy JSON memory block",
    );
  });

  it("merges memory entries case-insensitively and keeps latest spelling", () => {
    expect(mergeMemoryEntries(
      ["Likes Tea.", "Uses metric units."],
      ["likes tea.", "Prefers concise replies."],
    )).toEqual([
      "likes tea.",
      "Uses metric units.",
      "Prefers concise replies.",
    ]);
    expect(formatMemoryLines(["likes   tea."])).toBe("- likes tea.");
  });

  it("normalizes documents without flattening markdown", () => {
    expect(normalizeRelationshipMemoryDocument(
      "  - Likes tea.  \r\n\r\n- Uses metric. \r\n",
    )).toBe("- Likes tea.\n\n- Uses metric.");
  });

  it("recognizes exact blocks only at line boundaries", () => {
    expect(containsExactMemoryBlock("- Likes catering.", "cat")).toBe(false);
    expect(containsExactMemoryBlock("- Likes catering.\ncat", "cat")).toBe(true);
    expect(countMemoryOccurrences("one two one", "one")).toBe(2);
    expect(countMemoryOccurrences("aaa", "aa")).toBe(2);
    expect(() => replaceRelationshipMemory("aaa", {
      oldText: "aa",
      newText: "b",
    })).toThrow("not unique");
    expect(containsExactMemoryBlock("anything", "")).toBe(false);
    expect(countMemoryOccurrences("anything", "")).toBe(0);
  });

  it("offers pure append and replace operations", () => {
    expect(appendRelationshipMemory("- Likes tea.", {
      content: "Uses metric units.",
    })).toEqual({
      content: "- Likes tea.\nUses metric units.",
      changed: true,
    });
    expect(replaceRelationshipMemory("- Likes tea.", {
      oldText: "tea",
      newText: "coffee",
    })).toEqual({
      content: "- Likes coffee.",
      changed: true,
    });
    expect(replaceRelationshipMemory("- Likes tea.", {
      oldText: "- Likes tea.",
      newText: "",
    })).toEqual({ content: "", changed: true });
  });

  it("keeps the shared mutation union behavior", () => {
    expect(applyRelationshipMemoryMutation("- Likes tea.", {
      kind: "append",
      content: "Uses metric units.",
    })).toEqual({
      content: "- Likes tea.\nUses metric units.",
      changed: true,
    });
    expect(applyRelationshipMemoryMutation("- Likes tea.", {
      kind: "replace",
      oldText: "tea",
      newText: "coffee",
    })).toEqual({ content: "- Likes coffee.", changed: true });
  });

  it("makes retries idempotent without weakening first-attempt errors", () => {
    const replacement = { oldText: "tea", newText: "coffee" };
    expect(() => replaceRelationshipMemory("- Likes coffee.", replacement))
      .toThrow("was not found");
    expect(replaceRelationshipMemory("- Likes coffee.", replacement, {
      allowAlreadyApplied: true,
    })).toEqual({ content: "- Likes coffee.", changed: false });
  });

  it("enforces revision conflicts and escaped prompt context", () => {
    expect(() => assertExpectedRelationshipMemoryRevision({ revision: 3 }, 2))
      .toThrow("expected 2, actual 3");
    expect(formatRelationshipMemoryContext("- Likes <tea> & coffee."))
      .toBe([
        "<relationship_memory>",
        "- Likes &lt;tea&gt; &amp; coffee.",
        "</relationship_memory>",
      ].join("\n"));
  });

  it("enforces and validates compaction", () => {
    expect(shouldCompactRelationshipMemory(
      "x".repeat(MAX_RELATIONSHIP_MEMORY_LENGTH - 1),
    )).toBe(false);
    expect(shouldCompactRelationshipMemory(
      "x".repeat(MAX_RELATIONSHIP_MEMORY_LENGTH),
    )).toBe(false);
    expect(shouldCompactRelationshipMemory(
      "x".repeat(MAX_RELATIONSHIP_MEMORY_LENGTH + 1),
    )).toBe(true);
    expect(validateRelationshipMemoryCompaction({
      sourceContent: "x".repeat(MAX_RELATIONSHIP_MEMORY_LENGTH + 1),
      compactedContent: "x".repeat(MAX_RELATIONSHIP_MEMORY_LENGTH),
    })).toHaveLength(MAX_RELATIONSHIP_MEMORY_LENGTH);
    expect(validateRelationshipMemoryCompaction({
      sourceContent: "- Likes tea.\n- Likes tea.",
      compactedContent: "- Likes tea.",
    })).toBe("- Likes tea.");
    expect(() => validateRelationshipMemoryCompaction({
      sourceContent: "- Likes tea.",
      compactedContent: "- Likes tea.",
    })).toThrow("did not shorten");

    const error = new RelationshipMemoryCapacityError(
      MAX_RELATIONSHIP_MEMORY_LENGTH - 8,
      MAX_RELATIONSHIP_MEMORY_LENGTH + 1,
    );
    expect(error).toMatchObject({
      code: "relationship_memory_capacity",
      requiredReduction: 1,
      maxLength: MAX_RELATIONSHIP_MEMORY_LENGTH,
    });
  });

  it("rejects invalid workflow operations before consumer-owned ports", async () => {
    let repositoryCalls = 0;
    let compactorCalls = 0;
    const repository: RelationshipMemoryRepository = {
      async read() {
        repositoryCalls += 1;
        return { content: "", revision: 1 };
      },
      async wasOperationApplied() {
        repositoryCalls += 1;
        return false;
      },
      async commit() {
        repositoryCalls += 1;
        return { status: "conflict" };
      },
    };
    const oversized = "x".repeat(MAX_RELATIONSHIP_MEMORY_LENGTH + 1);
    const mutations = [
      { kind: "append", content: oversized },
      { kind: "replace", oldText: oversized, newText: "" },
      { kind: "replace", oldText: "x", newText: oversized },
    ] as const;

    for (const [index, mutation] of mutations.entries()) {
      await expect(executeRelationshipMemoryOperation({
        repository,
        operationId: `oversized-${index}`,
        operation: { kind: "mutate", mutation },
        compactor: async () => {
          compactorCalls += 1;
          return "compacted";
        },
      })).rejects.toThrow();
    }
    for (const [index, operation] of [
      { kind: "typo" },
      { kind: "compact", unknown: true },
    ].entries()) {
      await expect(executeRelationshipMemoryOperation({
        repository,
        operationId: `invalid-operation-${index}`,
        operation: operation as never,
        compactor: async () => {
          compactorCalls += 1;
          return "compacted";
        },
      })).rejects.toThrow();
    }
    expect(repositoryCalls).toBe(0);
    expect(compactorCalls).toBe(0);
  });

  it("commits a document exactly at the inclusive maximum without compaction", async () => {
    const content = "x".repeat(MAX_RELATIONSHIP_MEMORY_LENGTH);
    const repository = memoryRepository("");
    const compactor = vi.fn(async () => "compacted");

    await expect(executeRelationshipMemoryOperation({
      repository,
      operationId: "remember-at-maximum",
      operation: {
        kind: "mutate",
        mutation: { kind: "append", content },
      },
      compactor,
    })).resolves.toMatchObject({
      status: "applied",
      compacted: false,
      document: { content },
    });
    await expect(executeRelationshipMemoryOperation({
      repository,
      operationId: "compact-at-maximum",
      operation: { kind: "compact" },
      compactor,
    })).resolves.toMatchObject({
      status: "unchanged",
      compacted: false,
      document: { content },
    });
    expect(compactor).not.toHaveBeenCalled();
  });

  it("executes mutation and compaction through consumer-owned ports", async () => {
    const repository = memoryRepository(
      "x".repeat(MAX_RELATIONSHIP_MEMORY_LENGTH - 5),
    );
    const result = await executeRelationshipMemoryOperation({
      repository,
      operationId: "remember-1",
      operation: {
        kind: "mutate",
        mutation: { kind: "append", content: "new preference" },
      },
      compactor: async ({ document, maximumLength, sourceContent }) => {
        expect(document).toEqual({
          content: "x".repeat(MAX_RELATIONSHIP_MEMORY_LENGTH - 5),
          revision: 1,
        });
        expect(maximumLength).toBe(MAX_RELATIONSHIP_MEMORY_LENGTH);
        expect(sourceContent).toContain("new preference");
        return "Condensed preferences including the new preference.";
      },
    });

    expect(result).toMatchObject({
      status: "applied",
      compacted: true,
      attempts: 1,
      document: { revision: 2 },
    });
  });

  it("retries compare-and-swap conflicts and recognizes durable replays", async () => {
    const repository = memoryRepository("- Likes tea.", 1, true);
    const input = {
      repository,
      operationId: "correct-1",
      operation: {
        kind: "mutate" as const,
        mutation: {
          kind: "replace" as const,
          oldText: "tea",
          newText: "coffee",
        },
      },
    };

    await expect(executeRelationshipMemoryOperation(input)).resolves
      .toMatchObject({ status: "already_applied", attempts: 2 });
    await expect(executeRelationshipMemoryOperation(input)).resolves
      .toMatchObject({ status: "already_applied" });
  });

  it("reconciles the same operation committed during the check/read race", async () => {
    let checks = 0;
    let reads = 0;
    const original: RelationshipMemoryDocument = {
      content: "- Likes tea.",
      revision: 1,
    };
    const applied: RelationshipMemoryDocument = {
      content: "- Likes coffee.",
      revision: 2,
    };
    const repository: RelationshipMemoryRepository = {
      async read() {
        reads += 1;
        return reads === 1 ? original : applied;
      },
      async wasOperationApplied() {
        checks += 1;
        return checks > 1;
      },
      async commit() {
        throw new Error("commit must not run for a durable replay");
      },
    };

    await expect(executeRelationshipMemoryOperation({
      repository,
      operationId: "correct-raced",
      operation: {
        kind: "mutate",
        mutation: { kind: "replace", oldText: "tea", newText: "coffee" },
      },
    })).resolves.toEqual({
      status: "already_applied",
      document: applied,
      compacted: false,
      attempts: 1,
    });
    expect(reads).toBe(2);
  });

  it("does not infer retry success from unrelated replacement text", async () => {
    let document: RelationshipMemoryDocument = {
      content: "- Likes tea.\n- Coffee is served at noon.",
      revision: 1,
    };
    let commits = 0;
    const repository: RelationshipMemoryRepository = {
      async read() {
        return document;
      },
      async wasOperationApplied() {
        return false;
      },
      async commit() {
        commits += 1;
        document = {
          content: "- Likes juice.\n- Coffee is served at noon.",
          revision: 2,
        };
        return { status: "conflict" };
      },
    };

    await expect(executeRelationshipMemoryOperation({
      repository,
      operationId: "correct-tea",
      operation: {
        kind: "mutate",
        mutation: { kind: "replace", oldText: "tea", newText: "coffee" },
      },
    })).rejects.toThrow("was not found");
    expect(commits).toBe(1);
  });

  it("fails after the configured conflict budget", async () => {
    const repository = memoryRepository("- Likes tea.", Number.POSITIVE_INFINITY);
    await expect(executeRelationshipMemoryOperation({
      repository,
      operationId: "append-1",
      operation: {
        kind: "mutate",
        mutation: { kind: "append", content: "Uses metric units." },
      },
      maxAttempts: 2,
    })).rejects.toEqual(
      expect.objectContaining<Partial<RelationshipMemoryConflictError>>({
        code: "relationship_memory_conflict",
        attempts: 2,
      }),
    );
  });

  it("reconciles a same-operation commit after the final conflict", async () => {
    let applied = false;
    const document: RelationshipMemoryDocument = {
      content: "- Likes tea.",
      revision: 1,
    };
    const repository: RelationshipMemoryRepository = {
      async read() {
        return document;
      },
      async wasOperationApplied() {
        return applied;
      },
      async commit() {
        applied = true;
        return { status: "conflict" };
      },
    };

    await expect(executeRelationshipMemoryOperation({
      repository,
      operationId: "append-raced",
      operation: {
        kind: "mutate",
        mutation: { kind: "append", content: "- Likes coffee." },
      },
      maxAttempts: 1,
    })).resolves.toMatchObject({
      status: "already_applied",
      attempts: 1,
    });
  });
});

function memoryRepository(
  content: string,
  conflictsBeforeCommit = 0,
  applyConflictedCommit = false,
): RelationshipMemoryRepository {
  let document: RelationshipMemoryDocument = { content, revision: 1 };
  let conflicts = 0;
  const applied = new Set<string>();

  return {
    async read() {
      return { ...document };
    },
    async wasOperationApplied(operationId) {
      return applied.has(operationId);
    },
    async commit(input: RelationshipMemoryCommitInput) {
      if (input.expectedRevision !== document.revision) {
        return { status: "conflict" };
      }
      if (conflicts < conflictsBeforeCommit) {
        conflicts += 1;
        if (applyConflictedCommit) {
          document = {
            content: input.content,
            revision: document.revision + 1,
          };
          applied.add(input.operationId);
        }
        return { status: "conflict" };
      }
      document = {
        content: input.content,
        revision: document.revision + 1,
      };
      applied.add(input.operationId);
      return { status: "committed", document: { ...document } };
    },
  };
}
