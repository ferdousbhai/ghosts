# @summonghost/app-tool-cache

Application-wide exact-request caching with deterministic SHA-256 keys, five-minute expiration, bounded values, and concurrent-miss coordination.

Persisted results use the separately exported five-minute `APP_TOOL_CACHE_TTL_MS`. Misses are deduplicated only while the provider request holds the exported 30-second `APP_TOOL_CACHE_LEASE_TTL_MS`; an expired lease wakes followers to retry so a dead leader cannot block the key for the result lifetime.

The core client is storage-neutral. `@summonghost/app-tool-cache/cloudflare` supplies a Durable Object implementation. Consumers decide which public results are safe to share and must keep identity, authorization, billing, and private data out of cache keys and values.
