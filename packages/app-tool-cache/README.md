# @summonghost/app-tool-cache

Application-wide exact-request caching with deterministic SHA-256 keys, five-minute expiration, bounded values, and concurrent-miss coordination.

Persisted results use the separately exported five-minute `APP_TOOL_CACHE_TTL_MS`. Misses are deduplicated while a leader is healthy: the client renews its lease during the provider load, and each renewal extends the exported 30-second `APP_TOOL_CACHE_LEASE_TTL_MS` window. A transient renewal error gets one short retry before the current lease deadline. Fulfillment, release, provider failure, and cancellation stop renewal, while an explicit renewal rejection marks leadership as lost. An abandoned lease still expires within 30 seconds and wakes followers to retry.

A provider result is returned and shared only when the current lease accepts its fulfillment. If renewal reports lost leadership, fulfillment rejects an expired lease, or the fulfillment outcome is indeterminate, the client discards that result and resumes coordination to receive the winner or acquire a new lease. The fulfillment result is discriminated by `accepted`: `{ accepted: false, persisted: false }` rejects stale leadership, while `{ accepted: true, persisted }` accepts the value and separately reports durable persistence. Admission-rejected, oversized, or storage-failed values can therefore be accepted and shared with current followers without claiming they were persisted.

## Coordinated breaking API

This hardening changes `AppToolCacheEntryRpc.fulfill` from `Promise<boolean>` to `Promise<AppToolCacheFulfillment>`. The old boolean represented persistence and could not distinguish a current, non-persisted result from stale-leader rejection. Consumers must update the cache client, RPC interface, and Durable Object implementation together; do not deploy a client that expects the union against an object still returning a boolean, or vice versa. Branch on `accepted` before using `persisted`.

The core client is storage-neutral. `@summonghost/app-tool-cache/cloudflare` supplies a Durable Object implementation. Consumers decide which public results are safe to share and must keep identity, authorization, billing, and private data out of cache keys and values.
