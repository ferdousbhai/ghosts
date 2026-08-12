# @summonghost/app-tool-cache

Application-wide exact-request caching with deterministic SHA-256 keys, five-minute expiration, bounded values, and concurrent-miss coordination.

The core client is storage-neutral. `@summonghost/app-tool-cache/cloudflare` supplies a Durable Object implementation. Consumers decide which public results are safe to share and must keep identity, authorization, billing, and private data out of cache keys and values.
