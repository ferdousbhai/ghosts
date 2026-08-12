# Contributing

Changes should improve a portable contract used by more than one application or clearly prepare one for reuse.

## Package criteria

A shared package must:

- avoid application credentials, identity, billing, and authorization policy;
- expose narrow consumer-injected boundaries;
- validate untrusted input at its boundary;
- include tests and documentation;
- work from an exact Git SHA before npm publication.

Run `pnpm check` before submitting changes. See [`AGENTS.md`](AGENTS.md) for the coordinated consumer workflow.
