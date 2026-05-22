# ADR-0003: Embedding model — `text-embedding-3-small`

- **Status:** Accepted
- **Date:** 2026-04-17
- **Deciders:** Serhii Melnychuk (project lead), Claude agents during Phase 3 build
- **Related:** ADR-0001 (decoupled ingest), ADR-0004 (chunking strategy), ADR-0005 (HNSW index), `docs/design/phase-3-roadmap.md` §Week 3

## Context

Week 3 of the Phase 3 roadmap introduces an embedding column on
`Evidence` rows. Every chunk produced during ingest is embedded so that
Week 4's retrieval layer can do cosine similarity search instead of
the MVP's "take the 80 most recent rows" fallback. We had to pick an
embedding provider + model before any of the downstream retrieval work
could begin.

The real-world target (from the roadmap's cost appendix): ~14 M input
tokens of embedding work per 50-repo / 500-doc engagement, plus
ongoing re-embedding when documents change. The model has to be cheap
enough that ingest cost stays a rounding error against consulting
fees, and the dimensionality has to fit pgvector's HNSW index without
pathological build time.

## Decision

Use **OpenAI `text-embedding-3-small`** (1536-dim) as the default
embedding model. The choice is expressed through a single env var —
`EMBEDDING_MODEL` — so swapping models is a restart, not a code change.

Concrete shape:

- `apps/web/src/server/services/ai/embedding-service.ts` constructs
  the OpenAI client with `maxRetries: 0`, matching the Claude client's
  discipline — every retry re-bills tokens, so each retry is a
  deliberate user action.
- `EMBEDDING_DIMENSIONS = 1536` is exported from the service and
  referenced by the Prisma migration (`vector(1536)`) so the two
  sources never drift.
- A **fake mode** derives deterministic 1536-dim vectors from
  `SHA-256(input)` when `EMBEDDING_MODE=fake` or `OPENAI_API_KEY` is
  unset. Unlocks CI + local runs without a funded key.
- One carve-out to the no-retries rule: the **backfill script**
  (`apps/web/prisma/backfill-embeddings.ts`) retries a rate-limit
  failure **once per batch** with a 5-second sleep. This is bulk-load,
  not real-time ingest — the user never sees it — and OpenAI's
  typical rate-limit recovery is seconds, not minutes. The carve-out
  is documented in the backfill script header and audited here.

## Alternatives considered

- **Voyage `voyage-3`** — comparable quality, similar price, but
  separate vendor account + API key, and the ecosystem around it
  (tooling, model-cards, community benchmarks) is thinner. Rejected
  for MVP; the `EMBEDDING_MODEL` env var keeps the door open to swap
  it in post-roadmap, especially if we adopt `voyage-code-3` for the
  code-heavy repo-ingest path (see Week 6 follow-ups).
- **Cohere `embed-english-v3.0`** — strong quality, decent price, but
  another vendor + account. Same rejection reason as Voyage.
- **In-house / open-weight models on CPU** (bge-small, E5). Viable on
  paper at zero per-token cost, but the worker image is already tight
  and we'd be trading $0.28 of OpenAI spend per engagement for
  roughly $0.28 of CPU time, plus the operational cost of hosting,
  quantising, and tracking versions. Rejected — this is a false
  economy at our scale.
- **`text-embedding-3-large`** (3072-dim) — ~3× the price, measurably
  better recall on retrieval benchmarks, but HNSW build time roughly
  doubles and the marginal retrieval lift is small on the prose-heavy
  corpora we index. Rejected for MVP; revisit once we have a real
  retrieval-quality benchmark to justify the step-up.

## Consequences

- **Positive.** Embedding cost for the target engagement is roughly
  $0.28 (see `docs/design/phase-3-roadmap.md` Appendix A) — noise
  against Claude analysis spend. 1536 dims fits HNSW comfortably.
- **Positive.** The `EMBEDDING_MODEL` + `OPENAI_API_KEY` +
  `EMBEDDING_MODE` env triple makes the swap-out a two-minute change,
  not a migration.
- **Negative.** We now depend on **two** AI providers — Anthropic for
  analysis, OpenAI for embeddings. Two keys to manage, two rate-limit
  regimes, two billing surfaces. The error classifier surfaces them
  distinctly so an admin sees "embedding provider down" vs. "analysis
  provider down" rather than a generic "AI_AUTH" soup.
- **Negative.** OpenAI model-version drift is real. We've had no
  promise that `text-embedding-3-small` won't be deprecated in a
  year. The `EMBEDDING_MODEL` env var + backfill script are the
  mitigation: swap the model, run backfill, done.
- **Neutral.** The fake-mode vectors live forever once written to the
  DB. A test DB with fake embeddings cannot be used to measure real
  retrieval quality. `EMBEDDING_MODE=fake` rows should never be mixed
  with live ones in the same assessment — we rely on per-environment
  DBs to enforce this.

## Follow-ups

- [ ] Week 4 — build the retriever on top of this service.
- [ ] Week 6 — revisit code-specific embeddings (Voyage `voyage-code-3`
      etc.) once the repo-linking path ships.
- [ ] Post-roadmap — evaluate `text-embedding-3-large` on a real
      retrieval benchmark; swap if the precision lift justifies the
      cost bump.

## References

- `apps/web/src/server/services/ai/embedding-service.ts`
- `apps/web/prisma/backfill-embeddings.ts`
- `docs/design/phase-3-roadmap.md` — Week 3, Appendix A (cost model)
- `docs/architecture/README.md` §1 (stack), §4 (data model)
