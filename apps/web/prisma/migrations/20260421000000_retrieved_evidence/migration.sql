-- Week 7: evidence traceability as first-class data (ADR-0011).
--
-- Introduces `retrieved_evidence_ids` on every AI-produced row that
-- already carries `evidence_ids`. Semantics:
--
--   evidence_ids            — the chunks the model chose to CITE.
--                             Best-effort, model-selected, may be empty.
--   retrieved_evidence_ids  — the full set the retriever GAVE the model.
--                             Recorded by the service layer; always the
--                             superset that bounded the model's choice.
--
-- Reviewers get a "cited vs retrieved" view on every finding / risk /
-- recommendation / domain score — they can see what the AI actually had
-- in context, not just what it surfaced in the output. Reviewer trust
-- beats storage cost, and the column is additive so old rows default
-- to `{}` without rewriting history.

ALTER TABLE "findings"
    ADD COLUMN "retrieved_evidence_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "risks"
    ADD COLUMN "retrieved_evidence_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "recommendations"
    ADD COLUMN "retrieved_evidence_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "domain_scores"
    ADD COLUMN "retrieved_evidence_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
