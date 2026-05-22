#!/usr/bin/env bash
#
# Smoke test for Phase 3 Week 4 — RAG-backed analysis.
#
# What this proves:
#   1. A full `run-analysis` on an assessment with a multi-document
#      corpus completes without error.
#   2. The Findings it produces reference Evidence rows that come from
#      **more than one source Document** — proof that retrieval is
#      selecting chunks by relevance rather than by recency, and isn't
#      collapsing onto whichever doc landed last.
#   3. At least one domain produces at least one Finding — catches the
#      failure mode where retrieval returns empty and the whole run
#      silently produces no output.
#
# Requirements (same prerequisites as the other smokes):
#   - `docker-compose up -d` for Postgres + Redis + MinIO.
#   - `pnpm dev` and `pnpm worker` running in two terminals.
#   - `APP_URL`, `SESSION_COOKIE`, `ASSESSMENT_ID`, `DATABASE_URL`
#     exported in the environment. The assessment must already have at
#     least two Documents ingested with embeddings populated (Week 3
#     smoke covers that).
#
# Usage: bash scripts/smoke/smoke-rag-analysis.sh
#
# Exit codes:
#   0 — pass.
#   1 — bad inputs / unreachable services.
#   2 — assertion failure (RAG didn't behave as specified).

set -euo pipefail

APP_URL="${APP_URL:-http://localhost:3000}"
ASSESSMENT_ID="${ASSESSMENT_ID:?ASSESSMENT_ID must be set}"
SESSION_COOKIE="${SESSION_COOKIE:?SESSION_COOKIE must be set}"
DATABASE_URL="${DATABASE_URL:?DATABASE_URL must be set}"

for bin in curl jq psql; do
    command -v "$bin" >/dev/null 2>&1 || {
        echo "Missing required binary: $bin" >&2
        exit 1
    }
done

# Precondition: the assessment must have evidence from >=2 distinct
# documents, otherwise the multi-source assertion below is vacuous.
distinct_docs=$(psql "$DATABASE_URL" -Atc \
    "SELECT COUNT(DISTINCT document_id) FROM evidences
      WHERE assessment_id = '$ASSESSMENT_ID'
        AND document_id IS NOT NULL
        AND embedding IS NOT NULL")
if [[ "${distinct_docs:-0}" -lt 2 ]]; then
    echo "[smoke] assessment needs evidence from >=2 documents with embeddings (got $distinct_docs)" >&2
    echo "[smoke] run smoke-embeddings.sh against at least two fixture docs first" >&2
    exit 1
fi
echo "[smoke] preconditions OK — $distinct_docs source documents with embeddings"

echo "[smoke] triggering analysis on $ASSESSMENT_ID ..."
run_response=$(curl -sS -X POST "$APP_URL/api/trpc/assessment.runAnalysis" \
    -H "Cookie: $SESSION_COOKIE" \
    -H "Content-Type: application/json" \
    -d "{\"json\":{\"assessmentId\":\"$ASSESSMENT_ID\"}}")

# The tRPC response shape is an envelope; a clean start returns an
# object with `result.data.json`. We don't assert the exact shape —
# just that nothing errored and the worker eventually produces rows.
if echo "$run_response" | jq -e '.error' >/dev/null 2>&1; then
    echo "[smoke] runAnalysis errored: $run_response" >&2
    exit 2
fi

# Poll until the analysis audit row lands. Bounded so a wedged worker
# fails the smoke instead of hanging CI.
deadline=$((SECONDS + 180))
analysis_audit=0
while [[ $SECONDS -lt $deadline ]]; do
    analysis_audit=$(psql "$DATABASE_URL" -Atc \
        "SELECT COUNT(*) FROM audit_logs
          WHERE entity_id = '$ASSESSMENT_ID'
            AND action = 'RUN_ANALYSIS'
            AND created_at > NOW() - INTERVAL '5 minutes'")
    if [[ "${analysis_audit:-0}" -ge 1 ]]; then
        break
    fi
    sleep 2
done

if [[ "${analysis_audit:-0}" -lt 1 ]]; then
    echo "[smoke] no RUN_ANALYSIS audit row landed within 180s" >&2
    exit 2
fi
echo "[smoke] RUN_ANALYSIS audit row present"

# Positive assertion: at least one Finding was produced.
finding_count=$(psql "$DATABASE_URL" -Atc \
    "SELECT COUNT(*) FROM findings WHERE assessment_id = '$ASSESSMENT_ID'")
if [[ "${finding_count:-0}" -lt 1 ]]; then
    echo "[smoke] expected >=1 Finding, got $finding_count — retrieval likely returned empty" >&2
    exit 2
fi
echo "[smoke] findings produced: $finding_count"

# The load-bearing check: the Evidence rows cited across all findings
# span more than one source Document. A pre-Week-4 `take: 80` world
# would collapse onto whichever doc ingested most recently; a working
# RAG layer spreads citations across the corpus.
distinct_cited_docs=$(psql "$DATABASE_URL" -Atc "
    SELECT COUNT(DISTINCT e.document_id)
      FROM findings f,
           LATERAL unnest(f.evidence_ids) AS eid
           JOIN evidences e ON e.id = eid
     WHERE f.assessment_id = '$ASSESSMENT_ID'
       AND e.document_id IS NOT NULL
")

if [[ "${distinct_cited_docs:-0}" -lt 2 ]]; then
    echo "[smoke] findings cite only $distinct_cited_docs source doc(s) — RAG is not spreading citations" >&2
    exit 2
fi
echo "[smoke] findings cite $distinct_cited_docs distinct source documents"

echo "[smoke] PASS"
