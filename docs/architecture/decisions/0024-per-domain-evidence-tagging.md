# ADR-0024: Per-domain evidence tagging — three complementary mechanisms

- **Status:** Accepted
- **Date:** 2026-05-10
- **Deciders:** Engineering
- **Related:**
  [ADR-0001](./0001-decouple-ingest-from-analyse.md) (where ingest
  classifies chunks),
  [ADR-0002](./0002-per-domain-analysis-fan-out.md) (the consumer of
  per-domain tags),
  [ADR-0011](./0011-evidence-traceability-first-class.md) (the
  Evidence Explorer UI),
  [ADR-0023](./0023-db-backed-feature-flags.md) (the flag that
  gates the auto-classifier).

## Context

`Evidence.domain` started life as a per-chunk tag, populated by
ingest. In practice the chunker never had enough information to
classify confidently and dumped every chunk into a single
`"ingested"` catch-all bucket. The analysis engine compensated by
treating `"ingested"` as available to every domain:

```ts
e.domain === opts.domain || e.domain === "ingested"
```

This worked for analysis but broke the Evidence Explorer's domain
filter — picking `security_iam (0)` returned nothing because the
strict SQL `domain = 'security_iam'` excluded the catch-all. The
filter was a no-op in the UI and a real signal in analysis, which
confused users and undermined the Explorer's value.

We need a tagging strategy that:

- Surfaces accurate per-domain counts in the Explorer.
- Doesn't break the analysis engine's catch-all semantics.
- Lets users correct mis-classifications without forcing a re-ingest.
- Doesn't burn AI tokens on every ingest just to back-fill tags.

## Decision

Three mechanisms layered on the same `Evidence.domain` column.

### 1. Upload-time tagging (cheapest, default)

New `Document.domain String?` column. The upload form exposes a
domain dropdown sourced from `Assessment.activeDomains`. The ingest
worker (`ingest-document.ts`) reads `doc.domain` and stamps every
chunk with that value via the chunker's existing `domain` parameter.

Skips silently for documents uploaded before this landed
(`Document.domain` is nullable; chunks default to `"ingested"`).

### 2. AI auto-classification (opt-in)

New AI task `ingest.domain_classifier` (Haiku-4.5 primary, GPT-5
fallback). Service at
`apps/web/src/server/services/ingest/domain-classifier.ts` batches
up to 32 chunks per call, asks the model to pick one of the
assessment's active domains or `"ingested"` for each chunk, and
writes the assignments back via a per-domain `updateMany`.

Hooked into the ingest worker **post-transaction** (ADR-0020 soft-
failure pattern): classification never blocks ingest success, a
failed call leaves the chunks in `"ingested"`, and an audit row
(`CHUNK_DOMAINS_CLASSIFIED` / `CHUNK_DOMAINS_CLASSIFY_FAILED`)
records the outcome.

Gated by DB-backed flag `features.autoClassifyChunks` (ADR-0023).
Off by default; a tenant that wants the cost trade can toggle it
on `/admin/settings`. New `"ingest"` `AiCallType` separates
classifier spend from analysis / agent spend on
`/admin/cost`.

### 3. Manual re-tag (post-hoc correction)

New `evidenceExplorer.retag` mutation. The Search-tab results
expose per-cluster checkboxes; selecting any cluster surfaces a
"Retag to…" toolbar with a domain picker (active domains + the
catch-all). The mutation operates on the *union of `memberIds`*
across selected clusters so near-duplicates retag together. Audit
row: `EVIDENCE_RETAGGED`.

### Retriever semantics

The retriever's domain filter widens to include `"ingested"`:

```sql
WHERE assessment_id = $1
  AND embedding IS NOT NULL
  AND (domain = $2 OR domain = 'ingested')
```

This matches what `analysis-engine.ts` does in JS and makes the
Explorer's domain dropdown intuitive — picking a domain returns
both the tagged chunks *and* the catch-all the analysis engine sees,
not a strict subset that surprises the user with zero results.

The dropdown shows `(N tagged)` counts so the user understands the
catch-all bucket is contributing on top.

## Alternatives considered

- **Always auto-classify at ingest.** Rejected — burns Anthropic
  tokens on every document for a feature most tenants don't need.
  Better as an opt-in flag.
- **Drop `Evidence.domain` and tag only at retrieval.** Rejected —
  retrieval is per-query, classification at scale on every search
  would be slow and expensive. The column is also the right shape
  for analysis's per-domain fan-out (ADR-0002).
- **Strict `domain = X` filter (no catch-all widen).** Rejected —
  divergence between analysis-engine and Explorer semantics is
  exactly the bug the Explorer's domain filter shipped with. Users
  would have to remember "the Explorer is stricter than analysis".
- **Single tagging mechanism only.** Rejected for either extreme:
  upload-only loses the long tail of mis-classifications;
  AI-only is expensive and unrecoverable; manual-only is too
  much busy-work. The three layered together each take a slice
  of the problem.

## Consequences

**Positive**

- Domain filter in the Evidence Explorer is now meaningful — picking
  `security_iam` actually narrows to security-tagged chunks plus the
  shared bucket.
- Per-tenant cost trade is explicit (`features.autoClassifyChunks`
  off by default).
- Mis-classifications are recoverable in seconds, not via re-ingest.
- The three mechanisms compose — upload-time tag wins, auto-
  classifier fills the gap when the upload didn't pick one, manual
  re-tag overrides either.
- New `"ingest"` `AiCallType` keeps the cost dashboard honest.

**Negative**

- More moving parts in the ingest path. The classifier hook adds an
  HTTP round-trip to the worker's critical path; latency-sensitive
  ingests can leave the flag off.
- Three mechanisms × interactions = subtle UX. We mitigate with
  the `domainLabel()` helper, a "Recent classifications" trail on
  the Templates page, and the per-row audit history on chunks.

**Neutral**

- The `"ingested"` bucket survives forever as the catch-all. We
  considered renaming it but decided "ingested" is descriptive
  enough and the in-place migration cost outweighed the clarity
  gain.

## Follow-ups

- Surface a per-chunk "tagged by" provenance (upload / classifier /
  manual) in the chunk preview UI.
- Bulk re-classification from the admin page (replay the
  classifier across an assessment after activating a new domain).
- Per-engagement default for the auto-classify flag — today it's
  workspace-wide.
