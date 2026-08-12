# ghosts

Public, reusable foundations behind [SummonGhost](https://summonghost.com) and related projects.

This repository makes portable mechanisms inspectable and keeps one tested source of truth for code shared by SummonGhost, Ask Dan, Ghostbuild, and other applications. It does **not** contain production secrets, private prompts, user data, authentication policy, billing policy, or application-specific authorization.

## Packages

- [`@summonghost/app-tool-cache`](packages/app-tool-cache) — exact-request caching, canonical keys, concurrent-miss coordination, and a Cloudflare Durable Object storage adapter.
- [`@summonghost/title-generation`](packages/title-generation) — provider-independent title prompts, provisional titles, scheduling heuristics, and output validation.

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
