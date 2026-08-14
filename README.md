# ghosts

> [!IMPORTANT]
> This repository is deprecated and archived. Its former consumers now own
> their implementations directly. The history remains available so old exact
> Git SHA dependencies can still be inspected and resolved.

No package in this repository is maintained or supported for new use. Use the
application-owned implementations in
[`summon-ghost`](https://github.com/ferdousbhai/summon-ghost),
[`ghost-build`](https://github.com/ferdousbhai/ghost-build), or
[`ask-dan`](https://github.com/ferdousbhai/ask-dan) instead.

## Historical packages

- [`@summonghost/app-tool-cache`](packages/app-tool-cache) — exact-request caching, canonical keys, concurrent-miss coordination, and a Cloudflare Durable Object storage adapter.
- [`@summonghost/compaction`](packages/compaction) — provider-neutral conversation compaction policy and controller, with an injected xAI adapter.
- [`@summonghost/context-documents`](packages/context-documents) — bounded Markdown context-document rendering.
- [`@summonghost/feedback-context`](packages/feedback-context) — provider-neutral message-feedback overlays.
- [`@summonghost/line-edit`](packages/line-edit) — versioned numbered reads and deterministic snapshot-bound edits.
- [`@summonghost/memory-contracts`](packages/memory-contracts) — shared `remember`/`forget` schemas and pure relationship-memory mutations.
- [`@summonghost/pi-tool-adapter`](packages/pi-tool-adapter) — product-neutral adaptation of application tools to Pi's `AgentTool` protocol.
- [`@summonghost/research`](packages/research) — standard research contracts, provider normalization, safe public URL reads, and pagination.
- [`@summonghost/title-generation`](packages/title-generation) — provider-independent title prompts, provisional titles, scheduling heuristics, and output validation.
- [`@summonghost/tool-discovery`](packages/tool-discovery) — admitted-catalog fuzzy discovery and activation state.
- [`@summonghost/tool-results`](packages/tool-results) — bounded private result snapshots and Unicode-safe pagination.

These packages were consumed from exact Git commit SHAs and were never
published to npm.

## Historical boundary

Packages own portable contracts and mechanisms. Applications continue to own authentication, authorization, tenant isolation, billing, persistence, tool availability, product prompts, and telemetry policy.

See [`docs/architecture.md`](docs/architecture.md) for the former design.

## Historical verification

```sh
pnpm install
pnpm check
```

MIT licensed.
