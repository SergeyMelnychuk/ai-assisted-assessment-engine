#!/usr/bin/env bash
#
# smoke-evidence-trail.sh — Phase 3 Week 7 (ADR-0011)
#
# Proves evidence traceability is wired end-to-end: after an analysis
# run, every Finding / Risk / Recommendation / DomainScore row carries
# a non-empty `retrieved_evidence_ids` set, and every id in that set
# resolves to a real Evidence row in the same assessment. Then hits the
# `evidenceExplorer.findingTrail` tRPC query for one finding and
# asserts it returns non-empty cited + retrieved lists.
#
# What this exercises (black box):
#   • analysis-engine / scoring-service persist retrievedEvidenceIds
#     alongside the existing (model-cited) evidenceIds.
#   • `evidenceExplorer.findingTrail` resolves both sets to evidence
#     with trail metadata.
#   • The retrieved set is a strict superset of the cited set (best-
#     effort; the model may omit cites entirely — we only assert
#     "retrieved non-empty").
#
# Dependencies (run `docker-compose up -d` first):
#   • Postgres with pgvector, Redis, MinIO, web on :3000, worker up.
#   • An assessment that has already had `run-analysis` completed —
#     i.e. findings exist. Pass its id as ASSESSMENT_ID.
#
# Usage:
#   scripts/smoke/smoke-evidence-trail.sh
#     ASSESSMENT_ID=<cuid>      # assessment with findings present
#     AUTH_COOKIE=<cookie>      # signed-in next-auth session cookie
#     DATABASE_URL=<url>        # Postgres connection string
#
# Exit codes:
#   0   all assertions pass
#   1   missing dependency (curl, jq, psql)
#   2   missing configuration (DATABASE_URL, ASSESSMENT_ID, AUTH_COOKIE)
#   3   no findings on the assessment
#   4   at least one row has empty retrieved_evidence_ids
#   5   at least one retrieved id does not resolve to an Evidence row
#   6   findingTrail tRPC call failed or returned empty lists

set -euo pipefail

# ────────────────────────────────────────────────────────────────────
# 0. dependency check
# ────────────────────────────────────────────────────────────────────
for bin in curl jq psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "missing dependency: $bin" >&2
    exit 1
  fi
done

: "${DATABASE_URL:?set DATABASE_URL (e.g. postgres://copilot:copilot@localhost:5432/copilot)}"
: "${ASSESSMENT_ID:?set ASSESSMENT_ID to an assessment that already has findings}"
: "${AUTH_COOKIE:?set AUTH_COOKIE to a signed-in next-auth session cookie}"

HOST="${HOST:-http://localhost:3000}"
echo "▶ smoke-evidence-trail.sh — assessment=$ASSESSMENT_ID"

# ────────────────────────────────────────────────────────────────────
# 1. pick a finding on this assessment
# ────────────────────────────────────────────────────────────────────
finding_id="$(psql "$DATABASE_URL" -At -c \
  "SELECT id FROM findings WHERE \"assessmentId\" = '$ASSESSMENT_ID' LIMIT 1;")"
if [[ -z "$finding_id" ]]; then
  echo "no findings on assessment $ASSESSMENT_ID — run analysis first" >&2
  exit 3
fi
echo "  → using finding $finding_id"

# ────────────────────────────────────────────────────────────────────
# 2. assert retrieved_evidence_ids non-empty across the four tables
# ────────────────────────────────────────────────────────────────────
for table in findings risks recommendations domain_scores; do
  empty="$(psql "$DATABASE_URL" -At -c \
    "SELECT COUNT(*) FROM $table
       WHERE \"assessmentId\" = '$ASSESSMENT_ID'
       AND (retrieved_evidence_ids IS NULL
            OR array_length(retrieved_evidence_ids, 1) IS NULL);")"
  if [[ "$empty" != "0" ]]; then
    echo "$table has $empty rows with empty retrieved_evidence_ids" >&2
    exit 4
  fi
  echo "  → $table: retrieved_evidence_ids non-empty on all rows"
done

# ────────────────────────────────────────────────────────────────────
# 3. every retrieved id resolves to a real Evidence row
# ────────────────────────────────────────────────────────────────────
dangling="$(psql "$DATABASE_URL" -At -c "
  WITH ids AS (
    SELECT unnest(retrieved_evidence_ids) AS id FROM findings
      WHERE \"assessmentId\" = '$ASSESSMENT_ID'
    UNION ALL
    SELECT unnest(retrieved_evidence_ids) FROM risks
      WHERE \"assessmentId\" = '$ASSESSMENT_ID'
    UNION ALL
    SELECT unnest(retrieved_evidence_ids) FROM recommendations
      WHERE \"assessmentId\" = '$ASSESSMENT_ID'
    UNION ALL
    SELECT unnest(retrieved_evidence_ids) FROM domain_scores
      WHERE \"assessmentId\" = '$ASSESSMENT_ID'
  )
  SELECT COUNT(*) FROM ids
    WHERE id NOT IN (
      SELECT id FROM evidences WHERE \"assessmentId\" = '$ASSESSMENT_ID'
    );")"
if [[ "$dangling" != "0" ]]; then
  echo "$dangling retrieved ids do not resolve to evidence rows" >&2
  exit 5
fi
echo "  → every retrieved id resolves to an Evidence row"

# ────────────────────────────────────────────────────────────────────
# 4. hit findingTrail via tRPC
# ────────────────────────────────────────────────────────────────────
echo "▶ calling evidenceExplorer.findingTrail for finding $finding_id..."
trail_response="$(curl -sS \
  -H "Cookie: $AUTH_COOKIE" \
  -H "content-type: application/json" \
  "$HOST/api/trpc/evidenceExplorer.findingTrail?input=$(jq -rn \
    --arg fid "$finding_id" '{json:{findingId:$fid}} | @uri')")"

cited_count="$(echo "$trail_response" \
  | jq '.result.data.json.cited | length // 0')"
retrieved_count="$(echo "$trail_response" \
  | jq '.result.data.json.retrievedOnly | length // 0')"

if [[ -z "$cited_count" || -z "$retrieved_count" ]]; then
  echo "findingTrail response malformed: $trail_response" >&2
  exit 6
fi
echo "  → cited=$cited_count retrievedOnly=$retrieved_count"

# retrieved (cited ∪ retrievedOnly) must be non-empty — a finding
# with zero retrieval context would contradict ADR-0011.
if (( cited_count + retrieved_count == 0 )); then
  echo "findingTrail returned empty cited + retrievedOnly" >&2
  exit 6
fi

echo "✔ smoke-evidence-trail.sh passed"
