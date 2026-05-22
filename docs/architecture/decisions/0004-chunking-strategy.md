# ADR-0004: Chunking strategy — recursive heading → paragraph → sentence, ~800/~100

- **Status:** Accepted
- **Date:** 2026-04-17
- **Deciders:** Serhii Melnychuk (project lead), Claude agents during Phase 3 build
- **Related:** ADR-0003 (embedding model), ADR-0005 (HNSW index), `docs/design/phase-3-roadmap.md` §Week 3

## Context

Evidence rows in the MVP were one-per-document; the run-analysis job
grabbed the 80 most recent and sent them to Claude as a flat list.
That works for a 5-doc playground engagement and collapses on 500-doc
real ones — both because the input no longer fits in one prompt and
because "most recent" isn't a useful ranking signal.

Week 3 swaps Evidence from document-grained to chunk-grained. Every
chunk becomes a retrievable unit keyed by an embedding vector. The
shape of that chunking — how big, how much overlap, where the
boundaries go — is the lever that dominates retrieval quality once
the embedding model is fixed.

## Decision

A **recursive hierarchical splitter**: heading → paragraph →
sentence, targeting **~800 tokens per chunk** with **~100 tokens
overlap** between adjacent chunks. Implemented in
`apps/web/src/server/services/document-chunker.ts` as a ~200 LOC pure
function `chunkText(text, opts?)`.

Token counts are estimated with the ubiquitous `Math.ceil(length / 4)`
heuristic — off by 10–20% on English prose, wildly off on code or
CJK, and we accept that error band for MVP. Chunking targets coarse
boundaries; exact counts only matter for the embedding API's per-call
batching ceiling, which `embedding-service.ts` handles separately.

Concrete invariants the implementation pins with unit tests:

- **Stable** — identical input yields identical chunks in the same
  order. (Determinism lets re-ingest skip work via `content_sha`.)
- **Heading-boundary respect** — a Markdown / plain-text heading line
  always starts a fresh chunk; chunks never straddle heading
  boundaries when avoidable. Each chunk carries the nearest preceding
  heading in `chunk_source.heading` for UI source trails.
- **Overlap coverage** — chunk N's tail overlaps chunk N+1's head by
  ~100 tokens of the same text, so a concept that straddles the
  boundary is indexable from both sides.
- **Multi-byte safe** — never splits a UTF-16 surrogate pair or a
  multi-byte grapheme.
- **Monotonic indices** — `chunk_index` is 0-based, contiguous, and
  strictly increasing within a document.

When a caller passes a `targetTokens` smaller than the default
overlap, the chunker auto-scales the overlap to `max(1,
floor(targetTokens/8))`. This is a test-ergonomics carve-out — tests
exercise tiny chunks without having to hand-pick overlap values —
and doesn't affect production ingest, which always uses the default
`{800, 100}`.

## Alternatives considered

- **Fixed-window chunking** (e.g. 1000 tokens, 200 overlap, no
  boundary awareness). Simpler. Retrieval quality drops measurably —
  a chunk that starts mid-heading makes the embedding average out
  across unrelated material, and the UI source trail degrades
  ("from line 3,840" instead of "from §Security Architecture"). The
  implementation saving is ~100 LOC; we don't buy enough to justify
  the quality hit. Rejected.
- **AST-aware chunking** (`tree-sitter` per language for code,
  headed-block parser for prose). Better retrieval on code. Requires
  per-language parsers in the worker image; each new language is an
  integration step. **Deferred to post-roadmap** — the roadmap calls
  out `tree-sitter` under "what lands after Week 8", and the recursive
  splitter is a clean no-breaking-change swap-in for it later.
- **Semantic chunking** (split on embedding-similarity drops between
  adjacent sentences). Produces variable-size chunks that align with
  topic shifts. Quality lift exists on the benchmarks. Cost: every
  chunk-boundary decision requires an embedding call during ingest,
  ~2–3× the embedding volume. Rejected for MVP.
- **A WASM tokenizer** (`tiktoken`, `gpt-tokenizer`) for exact token
  counts. Real counts would let us hit the embedding batch ceiling
  more tightly and size chunks predictably. Rejected because the WASM
  binary bloats the worker image, the startup cost adds worker
  cold-start latency, and the chunking invariants we actually care
  about don't need exact counts — `length/4` is good to within the
  ~10–20% error band and the chunker is robust to that.

## Consequences

- **Positive.** Retrieval quality scales with the embedding model's
  natural strength on semantically coherent passages — which is
  where heading-respecting chunks land.
- **Positive.** Source-trail UX in Week 7 gets a near-free
  ("from `architecture.md` §Security") because every chunk already
  carries its heading.
- **Positive.** `content_sha`-keyed re-ingest is trivially correct:
  deterministic chunking means hash matches iff content matches.
- **Negative.** We're under-counting tokens on code-heavy chunks,
  which means the occasional chunk is 30% over target. Embedding
  still works — OpenAI accepts up to 8k tokens per input — but the
  semantic cohesion weakens. Acceptable for prose-heavy Week 3 work;
  Week 6's repo ingest will force us to revisit (AST-aware chunking
  candidate).
- **Neutral.** The `targetTokens / 8` auto-scale in test paths is
  production-dead-code but makes the chunker's test surface much
  cleaner. Documented as intentional in the module header.

## Follow-ups

- [ ] Week 8 — hyperparameter sweep (600 / 800 / 1200 tokens) on a
      real corpus with measured retrieval precision@10.
- [ ] Week 6 / post-roadmap — AST-aware chunking via `tree-sitter`
      once we're seriously ingesting code.
- [ ] Post-roadmap — reconsider a WASM tokenizer if precision@K
      measurements surface chunk-size drift as a real quality lever.

## References

- `apps/web/src/server/services/document-chunker.ts`
- `apps/web/src/server/services/document-chunker.test.ts`
- `docs/design/phase-3-roadmap.md` §Week 3, §Week 8
- `docs/architecture/README.md` §5 (ingest pipeline)
