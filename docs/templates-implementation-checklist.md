# Customer-Uploadable Templates — Implementation Checklist

🎉 **All four waves merged.** Final summary at the bottom.

Legend: ⬜ not started · 🟡 in flight · ✅ merged · ⏭️ deferred

---

## Wave 1 (in flight) + Wave 4-docs draft

| Agent | Stage | Scope | Status |
|-------|-------|-------|--------|
| A | 1.1–1.3 | Hand-author WBS binding JSON; seed APPROVED workspace template; smoke-test estimation fill | ✅ merged to main (commit e2ac890, 27 entries) |
| B | 3.1 | Add `pptx` branch to `filler.ts` + unit tests with fixture | ✅ merged (4 tests passing) |
| C | 4.1 | `/admin/templates` page; extend `TemplatesWorkspace` to support `engagementId={null}` | ✅ merged |
| L (draft) | 6.1–6.3 | User guide + ADR-0018 + README sidecar convention | ✅ merged |

**Wave 1 merge gate:** all four green on type-check; merged in order A → B → C → L-draft.

---

## Wave 2 (queued — kicks off after Wave 1 merges)

| Agent | Stage | Scope | Status |
|-------|-------|-------|--------|
| D | 2.2 + 2.3 | Template pickers on Team & Estimate + Deliverables popups; plumb `templateId` through queue → worker → fill-and-store | ✅ merged (backend + UI) |
| E | 2.1 | Proposer progress indicator (poll while pending, spinner) | ✅ merged |
| F | 3.3 | Retry button for failed proposer runs (`reproposeBinding` mutation + UI) | ✅ merged |
| G | 3.2 | Per-role hours/cost on `RoleProposal` (schema + migration + estimation service + engine-outputs) | ⏭️ deferred (pending decision) |

**Wave 2 merge gate:** D → E → F → G in that order. Coordinate `template.ts` and `templates-workspace.tsx` edits.

---

## Wave 3 (queued — kicks off after Wave 2 merges)

| Agent | Stage | Scope | Status |
|-------|-------|-------|--------|
| H | 2.4 + 2.5 | "Download populated file" CTAs on Team & Estimate + Deliverables; Recent fills section on Templates tab | ✅ merged |
| I | 3.4 | Form-driven binding editor (table-based, with raw JSON toggle) | ⏭️ optional — deferred |
| J | 5.1–5.3 | Service-layer tests: filler (xlsx/docx/pptx), engine-outputs, binding-proposer | ✅ merged (16 tests passing) |

---

## Wave 4 (final pass)

| Agent | Stage | Scope | Status |
|-------|-------|-------|--------|
| K | 5.4 + 5.5 | Router authz tests + integration test (upload → propose → approve → fill) | ✅ merged (10 router + 2 integration tests) |
| L (final) | 6.1–6.3 | Polish docs, finalize ADR (CHANGELOG.md not present, skipped) | ✅ merged |

---

## Open decisions

- [ ] **Per-role hours storage** (Stage 3.2 / Agent G): add columns to `RoleProposal` OR extract from `Estimate.roleBreakdown` JSON. Default plan: add columns. **User confirmation needed before launching Agent G.**
- [ ] **Form-driven binding editor** (Stage 3.4 / Agent I): defer unless required.

---

## Notes for the orchestrator

- Each agent runs in its own git worktree (`isolation: "worktree"`).
- Briefs are self-contained: agents have no memory of the design conversation.
- Verify after merge, not after agent return — agent summaries describe intent.
- Migrations serialise: only Agent G writes a migration in this plan.
- Type-check (`pnpm --filter @copilot/web type-check`) is the canonical gate.

---

## Final summary

**Test count:** 28 passing across 5 files (filler, engine-outputs, binding-proposer, router, integration).

**Type-check:** clean.

**Branches merged into `white-labeled`:**
- Wave 1: A (seed) → B (pptx filler) → C (admin page) → L-draft (initial docs)
- Wave 2: D (pickers + plumbing) + E (proposer progress) + F (retry button)
- Wave 3: H (download CTAs + recent fills) + J (service-layer tests)
- Wave 4: K (router + integration tests) + L-final (docs polish)

**Deferred (intentional):**
- G — per-role hours/cost on `RoleProposal`. Engine outputs zero for `roles[*].hoursLow|hoursHigh|costLow|costHigh` until that decision lands. Documented in ADR-0018 as a known follow-up.
- I — form-driven binding editor. JSON textarea is sufficient for power users; defer until customer feedback demands it.

**Known limitations (documented in user guide + ADR-0018):**
- pptx split-run tokens not handled — authors retype tokens in one edit as a workaround.
- Per-role distributions are zeros until G lands.

**Documentation:**
- `docs/guides/templates.md` — user guide.
- `docs/architecture/decisions/0018-template-binding.md` — design rationale.
- `packages/knowledge-seed/estimation-templates/README.md` — sidecar convention.
