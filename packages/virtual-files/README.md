# @summonghost/virtual-files

Portable contracts and pure mechanics for discovering an authorized virtual
filesystem. The package provides a bounded `find` input schema, lexical
normalization, weighted in-memory BM25 ranking, safe SQLite FTS query
construction, and deterministic model-facing result formatting.

Consumers own storage, path resolution, authorization, visibility, redaction,
and read/write execution. They must supply only entries already admitted for the
current caller and must re-authorize every later read; a returned path is a
reference, never a capability.

`readBoundedTextLines` provides a framework-neutral streaming read boundary. It
caps lines and UTF-8 output without buffering the complete file; consumers still
own path authorization, binary-file policy, and storage access.

`find` deliberately covers both inventory and content discovery:

- omit `query` to enumerate entries recursively under `root`;
- provide `query` to rank path, title, tags, and body matches; and
- pass a returned file path to the consumer's `read` tool.

This keeps virtual-file discovery independent from product concepts such as
creator, visitor, tenant, community ownership, billing, or persistence.
