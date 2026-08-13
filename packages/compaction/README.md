# @summonghost/compaction

Provider-neutral conversation-compaction policy, sequencing, background scheduling, stale-write coordination, and replacement validation. Consumers inject token counting, snapshot creation, snapshot application, scheduling, persistence, and observability.

The optional `@summonghost/compaction/xai` subpath builds and validates xAI native compaction requests. It accepts an application-owned authenticated transport, so credentials, base URLs, retries, billing, and telemetry stay outside this package.

## Core API

```ts
import {
  canApplyConversationCompaction,
  conversationCompactionKey,
  createConversationCompactionController,
  decideConversationCompaction,
} from "@summonghost/compaction";
```

- `decideConversationCompaction` selects `"none"`, `"background"`, or `"blocking"` from a validated token policy.
- `createConversationCompactionController` preserves append-only history, serializes preparation, schedules proactive snapshots when configured, and validates blocking replacements against the hard limit.
- `conversationCompactionKey` creates an encoded, revisioned coordination key.
- `canApplyConversationCompaction` guards persisted snapshots against stale or reordered history.
- `ConversationCompactionSupersededError` and `ConversationCompactionLimitError` identify superseded work and unsafe replacements.

A scheduled background `run()` creates a snapshot but does not apply it to the in-memory controller. Pending state lasts until that guarded run settles, then clears on either success or failure. Successful completion suppresses duplicate proactive scheduling for unchanged history; a new history tail permits new work, while failure permits retry. Repeated calls to the same `run()` share its single snapshot attempt. Completion from superseded work cannot clear a newer pending run. The consumer owns durable application and stale-write checks. `latestBlockingSnapshot()` reports only snapshots applied by a blocking preparation; `latestSnapshot()` remains as a deprecated alias.

## xAI API

```ts
import {
  buildXaiCompactionInput,
  createXaiCompactionAdapter,
  parseXaiNativeUsage,
  readXaiCompletedResponseOutput,
  readXaiResponseInput,
} from "@summonghost/compaction/xai";
```

The adapter uses `/tokenize-text` and `/responses/compact`. Its timeout remains active while the response body is streamed, and the transport signal is aborted on expiry. Responses are limited to 16 MiB, token counts and token-ID arrays to 2,000,000, and encrypted compaction content to 8 Mi characters; the exported `XAI_COMPACTION_MAX_*` constants expose these boundaries. Compaction items, token IDs, and usage are strictly validated.

Errors returned by the provider or application-owned transport are normalized: public messages retain an HTTP status when available but never include upstream response bodies, invalid JSON, or transport error details. The adapter depends only on standard web APIs (`AbortController`, `Response`, `TextDecoder`, `TextEncoder`, and `ReadableStream`); there are no runtime package dependencies.
