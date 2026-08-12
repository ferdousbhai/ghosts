# @summonghost/feedback-context

Provider-independent helpers for rendering reaction metadata and attaching it to the exact assistant message it describes without mutating the source messages.

Feedback is untrusted data, not model instructions. Whenever feedback is attached, consumers must also add `FEEDBACK_CONTEXT_POLICY` to trusted system context. Consumers remain responsible for supplying verified reaction metadata, preserving message-index integrity, and adapting structured provider content safely.

Rendering inspects at most the first 16 reaction candidates for each assistant message, including candidates merged from repeated feedback entries. Raw reaction values are limited to 32 Unicode code points and raw attributions to 80 before trimming; invalid, empty, duplicate, and excess candidates are omitted.
