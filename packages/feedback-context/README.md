# @summonghost/feedback-context

Provider-independent helpers for rendering reaction metadata and attaching it to the exact assistant message it describes without mutating the source messages.

Feedback is untrusted data, not model instructions. Whenever feedback is attached, consumers must also add `FEEDBACK_CONTEXT_POLICY` to trusted system context. Consumers remain responsible for supplying verified reaction metadata, preserving message-index integrity, and adapting structured provider content safely.
