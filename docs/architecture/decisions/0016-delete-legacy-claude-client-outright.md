# ADR-0016: Delete legacy `claude-client.ts` outright (amends ADR-0015 §9)

- **Status:** Accepted
- **Date:** 2026-04-21
- **Deciders:** Engineering
- **Related:**
  [ADR-0012](./0012-prompt-caching-and-cost-instrumentation.md),
  [ADR-0015](./0015-multi-provider-llm-routing.md) — amends §9.

## Context

[ADR-0015](./0015-multi-provider-llm-routing.md) §9 prescribes a
strangler migration: introduce the new `callAi` router, migrate
call-sites one at a time, and keep `apps/web/src/server/services/ai/claude-client.ts`
in place as a deprecated adapter for one release cycle so a bad router
change can be rolled back without re-threading call-sites.

On second reading during the implementation kickoff, that plan has
three concrete costs we didn't weigh heavily enough:

1. **Two live code paths for every AI call for one release.** Reviewers
   of any AI-touching PR during the overlap have to reason about
   which client ends up being invoked, and CI has to cover both.
   Non-obvious drift (e.g. a cache-hint fix landing on the router but
   not the adapter) ships silently.
2. **`claude-client.ts` becomes dead code the moment the last call-site
   migrates.** The "keep for one release" discipline rarely survives
   contact with the backlog — deprecated adapters in this codebase
   have a half-life measured in quarters, not releases.
3. **The rollback value is thin in practice.** A bad router change
   doesn't get safer by having an alternate client sitting next to
   it; the safer lever is a registry-level override (`AiModelOverride`,
   ADR-0015 §7) which can pin any task to any provider within a
   minute, or a git revert of the migration PR itself. Neither needs
   the old client present.

We already accepted ADR-0015 as "Accepted"; ADRs are immutable once
accepted, so this amendment is its own record rather than an edit.

## Decision

Delete `apps/web/src/server/services/ai/claude-client.ts` (and its
tests, `claude-client.timeout.test.ts`, plus the dead
`callClaudeWithImage` path) as part of the ADR-0015 Slice 1 migration
PR. The last call-site migration and the file deletion land in the
same commit. There is no adapter / overlap window.

Rollback, if ever needed, goes through one of:

- **Git revert** of the migration PR. All call-sites re-obtain the old
  client from history atomically.
- **`AiModelOverride`** (the runtime admin control in ADR-0015 §7) to
  pin any task to a specific provider + model without redeploying.
- **Env flip** — the router still honours the `ANTHROPIC_MODEL` env
  var, so forcing every Anthropic-routed task to a known-good model
  snapshot remains a one-line change.

Constants and helpers still worth preserving move to the router:

- `CLAUDE_CALL_TIMEOUT_MS` (120 s) becomes the default per-task
  timeout in `router.ts`, overridable per `AiTask` in the registry.
- `ClaudeCallTimeoutError` moves to `router.ts` under its existing
  class name (keeps `classifyProcessingError` matchers working).
- `parseJsonResponse` — if any call-site still relies on it after
  migration to `generateObject`, it moves to a shared
  `ai/json-parser.ts`. Otherwise it's deleted with the client.

The `MODEL` export disappears; the registry is the only answer to
"what model does this task use?"

## Alternatives considered

- **Keep ADR-0015 §9 as written** (one release cycle of overlap).
  Rejected for the three reasons above — the dual-path cost is paid
  by every reviewer during the overlap window, and the rollback lever
  the overlap was meant to preserve exists more cleanly via override
  + git revert.
- **Delete the file but keep `callClaudeWithImage` for future vision
  use.** Rejected: the function has no active caller today, vision
  calls will go through the same `callAi` surface once we wire them,
  and "keep this for later" code consistently rots. Re-add when there's
  a real caller.
- **Move the file to an `_archive/` directory instead of deleting.**
  Pure ritual — git history already preserves it. Reviewers seeing
  archived code conclude it's still valid somewhere.

## Consequences

**Positive**

- No two-path confusion during review. A single `callAi` surface is
  the only way to call an LLM in the codebase after the migration PR
  merges.
- No deprecated-adapter rot. The next engineer opening the AI
  services folder sees the router, the registry, the pricing, and
  nothing else — the code is self-describing.
- Forces migration discipline: the PR can't land unless every
  call-site is migrated, because compilation breaks otherwise. No
  half-migrated states sitting on a branch.

**Negative**

- The migration PR is bigger and cannot be merged in slices. Every
  Claude-touching call-site moves in one commit. Review takes longer
  on that single PR.
- Rollback from a bad router release is a git revert + redeploy, not
  a surgical env flip. Acceptable because `AiModelOverride` covers
  the provider-down case that originally motivated the overlap.

**Neutral**

- `claude-client.timeout.test.ts` deletes; the equivalent timeout
  coverage moves into `router.test.ts` (same assertions, different
  SUT).

## Follow-ups

- [ ] Ensure the ADR-0015 Slice 1 migration PR deletes
      `claude-client.ts`, `claude-client.timeout.test.ts`, and the
      `callClaudeWithImage` code path atomically with the last
      call-site migration.
- [ ] Port `CLAUDE_CALL_TIMEOUT_MS` and `ClaudeCallTimeoutError` into
      `router.ts` with their existing names.
- [ ] Cross-link this ADR from ADR-0015 §9 (status line note).

## References

- ADR-0015 §9 Migration path — amended by this ADR.
- ADR-0012 Prompt caching & cost instrumentation — the AuditLog shape
  still applies, emitted from the router instead of the client.
