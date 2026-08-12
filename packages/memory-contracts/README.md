# @summonghost/memory-contracts

Application-neutral relationship-memory schemas, pure append/exact-replace operations, document helpers, and an optimistic repository state machine with replay detection and optional compaction.

## Model-facing schemas

```ts
import {
  forgetInputSchema,
  rememberInputSchema,
} from "@summonghost/memory-contracts";

rememberInputSchema.parse({ content: "Prefers concise replies." });
forgetInputSchema.parse({ memory: "Prefers detailed replies." });
forgetInputSchema.parse({
  memory: "Prefers detailed replies.",
  correction: "Prefers concise replies.",
});
```

`remember` accepts exactly `{ content }`. `forget` accepts exactly `{ memory, correction? }`; omit `correction` to remove the exact selected passage. Inputs are one-line, trimmed, bounded, and reject unknown fields.

## Pure mutation contracts

- `appendRelationshipMemory(current, { content })`
- `replaceRelationshipMemory(current, { oldText, newText })`
- `relationshipMemoryAppendSchema`: `{ content }`
- `relationshipMemoryReplaceSchema`: `{ oldText, newText }`
- `relationshipMemoryMutationSchema`: the append/replace union

An empty `newText` removes the uniquely matched `oldText`. These functions perform no I/O.

## State machine boundary

`executeRelationshipMemoryOperation` owns deterministic mutation semantics, operation replay detection, compaction validation, and optimistic conflict retries. Consumers inject `RelationshipMemoryRepository` and, when needed, `RelationshipMemoryCompactor`.

The package intentionally contains no application scope or audience, persistence implementation, authorization, billing, provider selection, background dispatch, or telemetry policy. Consumers attach those concerns in adapters around the repository and compactor ports.

