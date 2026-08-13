# @summonghost/tool-results

Storage-neutral primitives for bounding model-facing tool output while retaining exact oversized results for private, offset-based pagination.

## What it owns

- well-formed Unicode normalization and surrogate-safe slicing;
- per-turn output and retained-result budgets;
- opaque `tool-result-<uuid>` handles scoped to one host-private run capability;
- immutable snapshot and page contracts;
- deterministic UTF-16 offset pagination and model-facing page formatting;
- a bounded, expiring in-memory store for synchronous, process-local retention.

It does not include agents, Durable Objects, authentication, authorization, billing, or product policy. `ToolResultStore` is deliberately synchronous: hosts may inject another synchronous retention implementation, but async durable persistence does not directly implement this interface and must be coordinated by the host outside the boundary.

## Usage

```ts
import {
  createInMemoryToolResultStore,
  createToolResultBoundary,
  formatStoredToolResultPage,
} from "@summonghost/tool-results";

const store = createInMemoryToolResultStore();
const boundary = createToolResultBoundary(store);

const output = boundary.deliver({
  content: veryLargeResult,
  toolCallId: "call-123",
  toolName: "read_file",
});

// Keep boundary.scope private. A read-tool implementation redeems the opaque
// model-visible handle only in that exact scope.
if (output.details?.paginated) {
  const page = store.getPage({
    handle: output.details.handle,
    scope: boundary.scope,
    contentStart: 40_000,
    maxCharacters: 40_000,
  });
  if (page) console.log(formatStoredToolResultPage(page));
}
```

Small results are returned directly. Oversized results are normalized to well-formed text, retained synchronously through the injected store, and represented by a bounded first page. If retention fails, delivery fails closed with a terminal unavailable result rather than encouraging a retry of a possibly side-effecting tool.

## Synchronous retention contract and security

`ToolResultStore.set` synchronously retains the exact normalized snapshot and returns `null` when it cannot safely retain it. A returned handle must remain bound to that exact content, metadata, and scope for its lifetime; retries create a new handle rather than changing an exposed snapshot. `getPage` is the synchronous redemption boundary: it must return `null` unless both the opaque handle and private scope match. `pinScope`, when implemented, prevents active-run snapshots from expiring.

The provided in-memory implementation is process-local and non-durable; it enforces per-entry, aggregate, count, and TTL limits. Other synchronous implementations must preserve the same snapshot, scope, and retention guarantees. Hosts that require async durable persistence must coordinate it outside this interface and decide how it relates to synchronous handle redemption. Never expose scopes to the model or treat a handle alone as authorization. Host applications remain responsible for caller authorization and tenant isolation.

Offsets and character limits use JavaScript UTF-16 indices so they round-trip with `String.prototype.slice`. Page boundaries are adjusted to keep surrogate pairs intact; `contentStart` and `contentEnd` in the returned page are the authoritative offsets for subsequent reads. Model-facing XML formatting escapes untrusted content and may shorten a page so the encoded envelope remains within the model-output limit; use its emitted `next_content_start` rather than assuming the requested page size.
