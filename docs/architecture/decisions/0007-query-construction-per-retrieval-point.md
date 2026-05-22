# ADR-0007: Query construction per retrieval point

- **Status:** Accepted
- **Date:** 2026-04-17
- **Deciders:** Engineering
- **Related:** `docs/design/phase-3-roadmap.md` §Week 4; ADR-0006 (retrieval fallback); `docs/architecture/README.md` §5, §6

## Context

`retrieve()` (see ADR-0006) takes a natural-language `query` string
and ranks chunks by cosine similarity to its embedding. The design
of that function is straightforward; the design of each call site's
*query* is not. Every AI call in the platform has different semantics,
so the question "what string do we hand to `retrieve()` for this
call?" has a different answer at every seam.

Getting this wrong is worse than not doing RAG at all — a mismatched
query retrieves chunks that look plausible but don't actually answer
the call's question, and the reviewer has no way to tell from the
finding alone. Consistency across call sites is load-bearing for
debuggability.

## Decision

A fixed matrix of call-site → query-source. New AI calls added later
pick a row from this table or add a new one via an ADR amendment —
no ad-hoc query construction at the call site.

| Call site | File | Query source | Scope | topK |
|---|---|---|---|---|
| Findings / risks / recs | `services/analysis-engine.ts` | Per-domain: domain name + scoring-criteria descriptions concatenated, from the active FRAMEWORK artifact | `domain = activeDomains[i]` | 10 per domain, merged |
| Domain scoring | `services/scoring-service.ts` | Per-domain: same rubric block as analysis, re-used | `domain = activeDomains[i]` | 10 per domain, merged |
| Deliverable sections | `services/deliverable-generator.ts` | `section.purpose` (falls back to `section.title` if empty) | none (cross-domain) | 8 per section |
| Question follow-ups | `services/question-engine.ts` (`generateFollowUpQuestions`) | Concatenation of the 5 most recent answered question + answer pairs; falls back to `activeDomains.join(" ")` if no answers yet | none | 20 |

A few cross-cutting rules:

- **Rubric/criteria sharing.** Analysis and scoring share the same
  per-domain rubric blurb. Building it twice would be pure
  duplication; both services call `loadRubricByDomain` /
  `loadDomainQueries` helpers that return the same shape. Downside:
  the two services now both know about the FRAMEWORK JSON shape.
  Accepted — the alternative is a third shared module for ~40 LOC.
- **Section `purpose` as query.** The deliverable template JSON
  already carries `purpose` as a human-readable one-liner ("Executive
  summary of the assessment's risk posture"). It's written for the
  prompt and reads well as a semantic query — no transformation
  needed.
- **Follow-up grounding.** Using recent answer text is what the
  roadmap called for ("grounded in latest answer+question"). We
  concatenate instead of running one retrieval per answer because
  a single well-retrieved set is more useful to the question-
  generator prompt than a jagged union of per-answer top-K.
- **No query rewriting.** We do not rephrase or "query expand" the
  string before embedding. Embedding models are robust to natural
  language; adding a rewrite step adds cost and latency for no
  measurable recall lift on our corpus. Re-evaluate in Week 8 if
  the tuning sweep disagrees.

## Alternatives considered

- **Single query = the full prompt.** Rejected. The full prompt
  carries the system instructions, rubric, and formatting directives —
  most of it is not what we want to retrieve *against*. The
  signal-to-noise in the embedding would be dominated by boilerplate.
- **One retrieval per section per domain for deliverables.** Rejected
  for MVP cost reasons — sections × domains × topK explodes the
  prompt budget. If Week 8 tuning shows sections genuinely need
  per-domain context, we'll split; today the purpose-as-query shape
  produces coherent drafts on the fixture corpus.
- **LLM-written queries.** Ask Claude to write the query string for
  each retrieval. Rejected — doubles the call count, introduces
  non-determinism, and the gain is speculative. Open item for
  post-roadmap if retrieval quality stalls.

## Consequences

- **Positive.** Every AI call uses a query shape that's documented,
  reproducible, and reviewable in one table. A reviewer investigating
  "why did this finding reference an off-topic chunk?" can trace the
  retrieval back to a specific query source.
- **Negative.** Two services (analysis, scoring) both know about the
  FRAMEWORK JSON shape. If the JSON structure changes (e.g. Week 8
  adds new rubric fields), both call sites update.
- **Neutral.** New AI calls added later must pick a row or extend the
  table via a follow-up ADR. This is intentional — avoids drift.

## Follow-ups

- [ ] Week 8: revisit the `topK` column. The roadmap's §Week 8 tuning
      pass is where these numbers get calibrated against a real
      corpus, not guessed.
- [ ] Week 7 (UX traceability): surface the retrieved `evidenceIds`
      from each call site so the reviewer can see exactly which
      chunks fed which finding.
- [ ] Post-roadmap: if a "global" retrieval query becomes useful
      (e.g. "what's unusual about this assessment as a whole?"), add
      a row rather than ad-hoc extension.

## References

- `docs/design/phase-3-roadmap.md` §Week 4
- `docs/architecture/README.md` §5, §6
- `apps/web/src/server/services/rag-retriever.ts`
- `apps/web/src/server/services/analysis-engine.ts`
- `apps/web/src/server/services/scoring-service.ts`
- `apps/web/src/server/services/deliverable-generator.ts`
- `apps/web/src/server/services/question-engine.ts`
- ADR-0006 (retrieval fallback policy)
