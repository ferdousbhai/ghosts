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

A scheduled background `run()` creates a snapshot but does not apply it to the in-memory controller. The consumer owns durable application and stale-write checks. `latestBlockingSnapshot()` reports only snapshots applied by a blocking preparation; `latestSnapshot()` remains as a deprecated alias.

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

The adapter uses `/tokenize-text` and `/responses/compact`, applies a bounded timeout, and strictly validates compaction items and usage. It depends only on standard web APIs (`AbortController`, `Response`, and `TextEncoder`); there are no runtime package dependencies.
