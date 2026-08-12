# @summonghost/app-tool-cache

Application-wide exact-request caching with deterministic SHA-256 keys, five-minute expiration, bounded values, and concurrent-miss coordination.

Persisted results use the separately exported five-minute `APP_TOOL_CACHE_TTL_MS`. Misses are deduplicated while a leader is healthy: the client renews its lease during the provider load, and each renewal extends the exported 30-second `APP_TOOL_CACHE_LEASE_TTL_MS` window. Fulfillment, release, provider failure, and cancellation stop renewal. An abandoned lease still expires within 30 seconds and wakes followers to retry, while renewal failures fail open without changing the provider result.

The core client is storage-neutral. `@summonghost/app-tool-cache/cloudflare` supplies a Durable Object implementation. Consumers decide which public results are safe to share and must keep identity, authorization, billing, and private data out of cache keys and values.
