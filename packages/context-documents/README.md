# @summonghost/context-documents

Portable helpers for normalizing and extracting Markdown context-document metadata, formatting documents for model context, and reconciling revisioned drafts.

Consumers own storage, revision assignment, editor state, authorization, and model execution; this package only handles deterministic document transformations.

## Markdown normalization

`normalizeMarkdown` removes redundant heading emphasis, unescapes periods in headings, collapses excess prose blank lines, and trims trailing prose whitespace. Backtick and tilde fenced code blocks with CommonMark's zero-to-three leading spaces—including an unclosed fenced tail—are preserved exactly.

## Context output bounds

`formatContextDocumentCatalog` accepts at most 100 documents. Catalog and full-document formatting each fail rather than truncate when the escaped XML output exceeds 256,000 UTF-16 code units (`String.length`), so tags are never emitted partially. Catalog output is bounded in aggregate, not per entry. The exported frozen `CONTEXT_DOCUMENT_LIMITS` object exposes `documents` and `outputCharacters` for upstream validation.
