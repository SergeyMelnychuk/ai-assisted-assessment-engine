#!/usr/bin/env bash
#
# Smoke test for Phase 3 Week 1 — ingest decoupled from analyse.
#
# What this proves:
#   1. An upload creates a Document row + Evidence rows via the ingest
#      worker.
#   2. The ingest path writes an `INGEST_DOCUMENT` audit-log row and
#      does NOT write a `PROCESS_DOCUMENT` row (legacy, pre-Week 1).
#   3. No Claude call happens during ingest — the audit details carry
#      chunk counts, not token counts.
#
# Requirements (same prerequisites as the other smokes):
#   - `docker-compose up -d` for Postgres + Redis + MinIO.
#   - `pnpm dev` and `pnpm worker` running in two terminals.
#   - `APP_URL`, `SESSION_COOKIE`, `ASSESSMENT_ID`, `DATABASE_URL`
#     exported in the environment (see scripts/smoke/README if present).
#
# Usage: bash scripts/smoke/smoke-ingest-decoupled.sh path/to/fixture.md
#
# Exit codes:
#   0 — pass.
#   1 — bad inputs / unreachable services.
#   2 — assertion failure (ingest didn't behave as specified).

set -euo pipefail

APP_URL="${APP_URL:-http://localhost:3000}"
ASSESSMENT_ID="${ASSESSMENT_ID:?ASSESSMENT_ID must be set}"
SESSION_COOKIE="${SESSION_COOKIE:?SESSION_COOKIE must be set}"
DATABASE_URL="${DATABASE_URL:?DATABASE_URL must be set}"
FIXTURE="${1:-}"

if [[ -z "$FIXTURE" || ! -f "$FIXTURE" ]]; then
    echo "Usage: $0 <fixture-file>" >&2
    exit 1
fi

for bin in curl jq psql; do
    command -v "$bin" >/dev/null 2>&1 || {
        echo "Missing required binary: $bin" >&2
        exit 1
    }
done

echo "[smoke] uploading $FIXTURE to $APP_URL ..."
upload_response=$(curl -sS -X POST "$APP_URL/api/documents/upload" \
    -H "Cookie: $SESSION_COOKIE" \
    -F "assessmentId=$ASSESSMENT_ID" \
    -F "file=@$FIXTURE")

document_id=$(echo "$upload_response" | jq -r '.documentId // empty')
if [[ -z "$document_id" ]]; then
    echo "[smoke] upload failed: $upload_response" >&2
    exit 2
fi
echo "[smoke] document id: $document_id"

# Poll until the ingest worker finishes. Bounded so a wedged worker
# fails the smoke instead of hanging CI.
deadline=$((SECONDS + 60))
ingest_status=""
while [[ $SECONDS -lt $deadline ]]; do
    ingest_status=$(psql "$DATABASE_URL" -Atc \
        "SELECT ingest_status FROM documents WHERE id = '$document_id'")
    if [[ "$ingest_status" == "READY" || "$ingest_status" == "FAILED" ]]; then
        break
    fi
    sleep 1
done

if [[ "$ingest_status" != "READY" ]]; then
    echo "[smoke] expected ingest_status=READY, got: $ingest_status" >&2
    exit 2
fi
echo "[smoke] ingest_status = READY"

evidence_count=$(psql "$DATABASE_URL" -Atc \
    "SELECT COUNT(*) FROM evidences WHERE document_id = '$document_id'")
if [[ "$evidence_count" -lt 1 ]]; then
    echo "[smoke] expected >=1 Evidence row, got $evidence_count" >&2
    exit 2
fi
echo "[smoke] evidence rows: $evidence_count"

# The load-bearing check: no legacy PROCESS_DOCUMENT audit action fires.
process_audit=$(psql "$DATABASE_URL" -Atc \
    "SELECT COUNT(*) FROM audit_logs
      WHERE entity_id = '$document_id'
        AND action IN ('PROCESS_DOCUMENT', 'PROCESS')")
if [[ "$process_audit" -ne 0 ]]; then
    echo "[smoke] unexpected legacy PROCESS audit rows: $process_audit" >&2
    exit 2
fi
echo "[smoke] no PROCESS_DOCUMENT audit entries (decoupling confirmed)"

# And the positive check: new INGEST_DOCUMENT row is present.
ingest_audit=$(psql "$DATABASE_URL" -Atc \
    "SELECT COUNT(*) FROM audit_logs
      WHERE entity_id = '$document_id'
        AND action = 'INGEST_DOCUMENT'")
if [[ "$ingest_audit" -lt 1 ]]; then
    echo "[smoke] expected >=1 INGEST_DOCUMENT audit row, got $ingest_audit" >&2
    exit 2
fi
echo "[smoke] INGEST_DOCUMENT audit row present"

# Spot-check: ingest audit details carry chunk counts, NOT token counts.
token_rows=$(psql "$DATABASE_URL" -Atc \
    "SELECT COUNT(*) FROM audit_logs
      WHERE entity_id = '$document_id'
        AND action = 'INGEST_DOCUMENT'
        AND details::text LIKE '%tokens%'")
if [[ "$token_rows" -ne 0 ]]; then
    echo "[smoke] INGEST audit row mentions tokens — AI leaked into ingest" >&2
    exit 2
fi

echo "[smoke] PASS"
