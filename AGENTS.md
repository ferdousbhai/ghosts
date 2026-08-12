# ghosts

Public reusable modules for SummonGhost-related applications.

## Rules

- Keep packages product-neutral, inspectable, and safe to publish. Never add secrets, user data, private prompts, deployment identifiers, or application-specific authorization/billing policy.
- Prefer pure contracts and mechanisms with consumer-injected provider, persistence, billing, and telemetry adapters.
- Preserve trust-boundary validation and deterministic behavior. Add focused tests for every nontrivial contract.
- Work on `main`; no branches, worktrees, or PRs unless requested.
- Before handoff, run `pnpm check` and `git diff --check`.

## Coordinated consumer updates

Consumers pin packages to an exact reachable Git commit. For a breaking or behavioral change:

1. Update this repository and its tests first.
2. During local coordination, consumers may temporarily use `link:../ghosts/packages/<package>`; never commit or push a `link:`, `file:`, branch, or moving-main dependency.
3. Run the affected consumer tests against that local link.
4. Commit and push `ghosts`, then obtain the immutable commit SHA.
5. Replace each temporary link with `github:ferdousbhai/ghosts#<full-sha>&path:/packages/<package>`, refresh its lockfile, and rerun that consumer's complete checks.
6. Update consumers independently; do not push a consumer until the pinned `ghosts` commit is publicly reachable.
7. Keep application adapters thin and remove superseded local implementations in the same change.
