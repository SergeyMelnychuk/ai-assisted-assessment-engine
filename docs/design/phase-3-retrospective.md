# Phase 3 retrospective

_Authored at the close of Week 8. Candid notes — if it reads dry, it
isn't honest._

Phase 3 was the eight-week push from "MVP works on a toy corpus" to
"end-to-end pipeline operators would trust with a real engagement".
This doc is the retrospective that ADR-0012 points at and that
closes the loop on `phase-3-roadmap.md`.

## What shipped

| Week | Headline | Reference |
|---|---|---|
| 1 | Decoupled ingest from analyse. Two BullMQ jobs; `Document.ingestStatus` is the pipeline source-of-truth. | ADR-0001 |
| 2 | Per-domain analysis fan-out. One Claude call per active domain, partial-success semantics, audit row carries per-domain status. | ADR-0002 |
| 3 | Embedding foundation — `text-embedding-3-small`, recursive ~800-token chunks, pgvector HNSW cosine index. Fake-mode for CI. | ADR-0003 / 0004 / 0005 |
| 4 | Retrieval wired into every AI call-site. Hybrid fallback when the domain filter underfills. Per-retrieval-point query construction. | ADR-0006 / 0007 |
| 5 | Bulk + archive ingest with safety gates (size, zip-slip, depth). Stream-extraction with child-Document fan-out. | ADR-0008 |
| 6 | Repository linking via GitHub tarball API. PAT per engagement, AES-256-GCM at rest. | ADR-0009 / 0010 |
| 7 | Evidence traceability end-to-end — Findings / Risks / Recommendations carry evidenceIds that survive to export. |  |
| 8 | Cost instrumentation + Anthropic prompt caching. `/admin/cost` rollup. Retrieval constants surfaced. Worker concurrency bumped 2→5. | ADR-0012 |

## What slipped

Plain list, no spin:

- **Chunking hyperparameter sweep.** Needed a labelled evaluation
  corpus we never built. Knobs surfaced as named constants in
  `retrieval-config.ts` so the sweep, when run, is a one-file edit.
  Moved to post-Phase-3 backlog.
- **Top-K tuning.** Same blocker, same mitigation.
- **Playwright E2E suite.** Big — a stable seed + CI browser runner
  we hadn't scoped. Deferred; `scripts/smoke/*.sh` covers the
  critical paths against a real local environment.
- **Final fixture-engagement cost integration test.** Needed the 50-
  repo / 500-doc fixture; defraction-scoped to `smoke-cost.sh`
  (asserts the audit trail fires and costs are sane, not that they
  match the model within ±10%).
- **Full diagram refresh.** Only `data-flow.mmd` was updated this
  week (cost-audit sidecar). Other diagrams drifted during Weeks
  1–7 and need a dedicated pass.
- **Worker observability.** Structured log format partially done —
  `AuditLog.details` shape is structured; the per-line `console.log`
  prefixes are still flat strings.

## Surprises

- **Fake-mode embeddings paid for themselves on day one.** The
  SHA-based deterministic vectors in `embedding-service.ts` meant
  every CI run and every worktree agent could exercise the full RAG
  path without a funded OpenAI key. We almost shipped a thin stub
  instead; the extra 20 lines for determinism turned out to be the
  single biggest productivity win of Phase 3.
- **Per-domain fan-out's fail-soft semantics mattered more than we
  expected.** Once we started running on real corpora we saw 529s
  from Anthropic on one domain out of eight roughly every third
  run. The partial-success audit-row shape (ADR-0002) meant the
  user got 7/8 domains rendered and a clear banner on the eighth,
  instead of an all-or-nothing failure.
- **Hybrid retrieval fallback kept catching thin corpora we hadn't
  anticipated.** ADR-0006's "widen don't pad" policy fires more
  often in practice than we modelled — small engagements with fewer
  than 10 documents per domain trigger it on almost every analysis.
  Worth measuring in the deferred sweep.
- **Prompt caching hit-rate was higher than the back-of-envelope
  estimate.** The system prompt + framework rubric for a per-domain
  call is ~6K tokens; with 8 domains per pass, the cache read/write
  ratio converges on 7:1 per pass. Real savings ≈ 30% of input
  spend, not 20%.

## What we'd do differently

- **Build the evaluation corpus first.** The chunking / top-K
  sweeps were planned for the last two days of Week 8, and the
  corpus they needed didn't exist. Had we allocated a day in Week
  3 — alongside the embedding foundation — to capture a ~20-
  document labelled set, both sweeps would have landed.
- **Start cost instrumentation in Week 1, not Week 8.** We burned
  real money on test runs across Weeks 3–7 and couldn't easily
  answer "which change made us more expensive" after the fact. One
  `AuditLog.action = 'AI_CALL'` row from day zero would have given
  us a time-series on every branch.
- **Decide Playwright E2E scope earlier.** By Week 6 it was clear
  we wouldn't fit a full suite; we kept it on the roadmap instead
  of explicitly punting it, which created a false sense that Week
  8 would pick it up.
- **Write ADRs in the *same PR* as the code.** Some ADRs (0006,
  0007) were retrofitted across two PRs. The forces-at-play sections
  were noticeably less sharp for those vs. the ones written
  alongside the change (0008, 0010, 0012).
- **Don't conflate "ingest retry" with "analysis retry".** The
  early `Document.processingStatus` column is now effectively dead
  alongside `ingestStatus` — we held off on the rename because
  retries-UI still reads it. One PR during Week 5 would have
  unblocked the cleanup; instead it's still open debt in
  architecture-doc §15.

## Post-Phase-3 backlog

Cross-linked to ADR follow-ups and arch §15 "Known limits":

- **Chunking + top-K hyperparameter sweep.** Needs labelled corpus
  first. See ADR-0012 "Follow-ups".
- **Continuous-analysis loop.** Re-trigger analysis on evidence
  change. See arch §15.
- **Multi-tenant isolation.** Membership / authz hooks already in
  place; needs `Tenant` row + FK cascade. See arch §15.
- **Code-aware embeddings.** Today code chunks use the same
  `text-embedding-3-small` pass as docs. Evaluate `text-embedding-
  3-large` + code-specific embedder for the repo-ingest path.
- **GitHub App.** ADR-0009 follow-up — replace PAT with App install
  so per-user token rotation stops hurting.
- **Playwright E2E suite.** Full flow: login → create engagement →
  upload doc → run analysis → review section → export DOCX.
- **Cost-instrumentation integration test.** Assert audit-row cost
  sum within ±10% of the SDK-reported token cost on a live run.
- **Full diagram refresh.** workspace.dsl, system-context,
  container-topology, deployment, sequence-analysis.
- **Structured worker log format.** JSON lines, ready for a log
  aggregator without sed-scraping prefixes.
- **`AuditLog` archive / partition.** Volume will matter once
  engagements land. See ADR-0012 "Consequences — Negative".
- **Drop `Document.processingStatus` duplication.** Transitional
  column documented in arch §15.

---

_If Phase 4 picks up from here, the single most load-bearing thing
to preserve is the "fail soft, record everything" discipline: every
AI call is attributable, every failure is re-runnable, and no
exception in an audit / cost path is ever allowed to wedge the
foreground work. That discipline is what lets us move fast in Phase
4 without re-litigating Phase 3's trust-but-verify decisions._

---

## Post-audit gap-fill (2026-04-18)

Nine shippable items from the Phase 3 roadmap audit landed in a
single follow-up commit — they are no longer part of the
post-Phase-3 backlog:

1. `scripts/smoke/smoke-ingest-shape.sh` (W1) — post-chunking shape
   assertions, zero AI spend.
2. `scripts/smoke/smoke-per-domain-analysis.sh` (W2) — extended
   with per-domain truncation / well-formedness assertion
   (ADR-0002).
3. `server/services/rag-retriever.integration.test.ts` (W4) —
   50-chunk in-memory pgvector stand-in, domain filter + fallback.
4. `server/services/rag-retriever.perf.test.ts` (W4) — 10k-chunk
   p95<200ms, `PERF_TEST=1`-guarded.
5. `api/documents/upload` multipart N-files support + unit test (W5).
6. `server/services/repo-ingest.integration.test.ts` (W6) —
   stub-`fetch` tarball + PAT scrub assertion.
7. Cross-page linkage Finding/Risk/Rec → Evidence Explorer with
   `q` + `domain` (W7).
8. `server/lib/logger.ts` + structured JSON log format in worker
   entry files (W8).
9. `server/services/ai/cost-instrumentation.integration.test.ts`
   (W8) — ±10% assertion via mocked Anthropic SDK.

The "What slipped" entries for worker observability and the
cost-instrumentation integration test are therefore resolved; the
remaining backlog items above (Playwright E2E, GitHub App, full
diagram refresh, AuditLog partitioning, `processingStatus` drop)
are still outstanding.

## Phase 4 update (2026-05-13)

This retrospective is a snapshot at the close of Phase 3 and is not
rewritten. For context, items the Phase 4 work has since resolved or
partially addressed:

- **Full diagram refresh — RESOLVED.** All nine `.mmd` files and
  `workspace.dsl` were audited and updated alongside the architecture
  README in May 2026, picking up multi-provider routing (ADR-0015),
  hybrid retrieval (ADR-0027), evidence citations (ADR-0028), the
  agent trace viewer (ADR-0026), and the repo-link / archive flows.
- **Hybrid retrieval (different shape — PARTIAL).** ADR-0027 shipped
  Postgres `tsvector` + cosine fused via Reciprocal Rank Fusion behind
  a feature flag. The labelled-corpus sweep this retrospective listed
  remains unfinished; the RRF path is independent of it.
- **Cost instrumentation extended.** The multi-provider router
  (ADR-0015) keeps the `AI_CALL` audit-row contract intact and adds
  `provider` + `cacheReadInputTokens` / `cacheCreationInputTokens` to
  the details blob.

Still outstanding from this retrospective's backlog: Playwright E2E,
GitHub App, AuditLog partitioning, `Document.processingStatus`
duplicate column drop, code-aware embeddings, chunking / top-K
labelled sweep.
