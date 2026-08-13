# ghosts

Public, reusable foundations behind [SummonGhost](https://summonghost.com) and related projects.

This repository makes portable mechanisms inspectable and keeps one tested source of truth for code shared by SummonGhost, Ask Dan, Ghostbuild, and other applications. It does **not** contain production secrets, private prompts, user data, authentication policy, billing policy, or application-specific authorization.

## Packages

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

Packages are currently consumed from exact Git commit SHAs. They are not published to npm yet.

## Boundary

Packages own portable contracts and mechanisms. Applications continue to own authentication, authorization, tenant isolation, billing, persistence, tool availability, product prompts, and telemetry policy.

See [`docs/architecture.md`](docs/architecture.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Development

```sh
pnpm install
pnpm check
```

MIT licensed.
