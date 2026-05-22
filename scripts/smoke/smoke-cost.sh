#!/usr/bin/env bash
#
# Smoke test for Phase 3 Week 8 — cost instrumentation (ADR-0012).
#
# What this proves:
#   1. A `run-analysis` on the given assessment writes one or more
#      `AI_CALL` rows to `audit_logs` with `details.callType =
#      'analysis'`.
#   2. The summed `details.estimatedCostUsd` across those rows is
#      strictly positive (proves the cost math runs) and less than
#      $1.00 (catches a pricing-table units regression — if we ever
#      record $300 for a single assessment, the table slipped a
#      decimal).
#
# This is a scaled-down proxy for the "full fixture engagement cost
# envelope" acceptance test listed in the Week 8 roadmap, which was
# deferred post-Phase-3 — see the retrospective.
#
# Requirements:
#   - `docker-compose up -d` for Postgres + Redis + MinIO.
#   - `pnpm dev` and `pnpm worker` running in two terminals.
#   - `APP_URL`, `SESSION_COOKIE`, `ASSESSMENT_ID`, `DATABASE_URL`
#     exported in the environment. The assessment must already have
#     ingested evidence (smoke-rag-analysis.sh covers that setup).
#
# Usage: bash scripts/smoke/smoke-cost.sh
#
# Exit codes:
#   0 — pass.
#   1 — required environment variables or binaries missing.
#   2 — no AI_CALL audit rows found for this assessment (instrumentation
#       didn't fire).
#   3 — cost sum is out of the sane range (<=0 or >=$1.00).

set -euo pipefail

APP_URL="${APP_URL:-http://localhost:3000}"
ASSESSMENT_ID="${ASSESSMENT_ID:-}"
SESSION_COOKIE="${SESSION_COOKIE:-}"
DATABASE_URL="${DATABASE_URL:-}"

if [[ -z "$ASSESSMENT_ID" || -z "$SESSION_COOKIE" || -z "$DATABASE_URL" ]]; then
    echo "[smoke-cost] missing one of ASSESSMENT_ID / SESSION_COOKIE / DATABASE_URL" >&2
    echo "[smoke-cost] export these before running; see smoke-rag-analysis.sh for the shape" >&2
    exit 1
fi

for bin in curl jq psql bc; do
    command -v "$bin" >/dev/null 2>&1 || {
        echo "[smoke-cost] missing required binary: $bin" >&2
        exit 1
    }
done

echo "[smoke-cost] triggering run-analysis on $ASSESSMENT_ID ..."
run_response=$(curl -sS -X POST "$APP_URL/api/trpc/assessment.runAnalysis" \
    -H "Cookie: $SESSION_COOKIE" \
    -H "Content-Type: application/json" \
    -d "{\"json\":{\"assessmentId\":\"$ASSESSMENT_ID\"}}")

if echo "$run_response" | jq -e '.error' >/dev/null 2>&1; then
    echo "[smoke-cost] runAnalysis errored: $run_response" >&2
    exit 2
fi

# Wait for the RUN_ANALYSIS audit row as our "worker finished" signal.
# The per-call AI_CALL rows land before it, so once this arrives the
# analysis-call cost rows are in place.
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
    echo "[smoke-cost] no RUN_ANALYSIS audit row landed within 180s" >&2
    exit 2
fi

# Count per-call AI_CALL rows with callType='analysis' for this
# assessment. Zero rows → instrumentation didn't fire.
ai_call_rows=$(psql "$DATABASE_URL" -Atc "
    SELECT COUNT(*)
      FROM audit_logs
     WHERE entity_id = '$ASSESSMENT_ID'
       AND action = 'AI_CALL'
       AND details->>'callType' = 'analysis'
       AND created_at > NOW() - INTERVAL '5 minutes'
")

if [[ "${ai_call_rows:-0}" -lt 1 ]]; then
    echo "[smoke-cost] no AI_CALL(analysis) rows for assessment $ASSESSMENT_ID — instrumentation didn't fire" >&2
    exit 2
fi
echo "[smoke-cost] found $ai_call_rows AI_CALL(analysis) rows"

# Sum the cost. psql returns a bare number; feed it to bc for the
# range check (bash arithmetic can't handle decimals).
cost_sum=$(psql "$DATABASE_URL" -Atc "
    SELECT COALESCE(SUM((details->>'estimatedCostUsd')::numeric), 0)
      FROM audit_logs
     WHERE entity_id = '$ASSESSMENT_ID'
       AND action = 'AI_CALL'
       AND details->>'callType' = 'analysis'
       AND created_at > NOW() - INTERVAL '5 minutes'
")

echo "[smoke-cost] summed analysis cost: \$$cost_sum"

# cost_sum must be > 0 and < 1.00 for the smoke to pass.
if ! printf '%s\n' "$cost_sum" | awk '$1 > 0 && $1 < 1.00 { exit 0 } { exit 1 }'; then
    echo "[smoke-cost] cost sum \$$cost_sum is out of sane range (expected 0 < x < 1.00)" >&2
    exit 3
fi

echo "[smoke-cost] PASS"
