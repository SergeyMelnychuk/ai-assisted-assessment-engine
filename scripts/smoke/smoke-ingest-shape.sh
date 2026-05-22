#!/usr/bin/env bash
#
# Smoke test for Phase 3 Week 1 Task 7 — post-chunking ingest shape.
#
# Complements `smoke-ingest-decoupled.sh` (which proves the *negative*:
# ingest does not call AI). This script proves the *positive* shape that
# landed after chunking + embedding were wired in:
#
#   1. The Document row transitions to `ingestStatus = 'INGESTED'` (or
#      the codebase-canonical terminal state for ingest — the assertion
#      accepts both `INGESTED` and the legacy alias `READY`).
#   2. Evidence rows land with count > 1 — confirming chunking produces
#      multiple rows per document, not a single blob.
#   3. No `AuditLog` row with `callType = 'analysis'` exists for the
#      engagement that owns the assessment. Ingest must never trigger an
#      AI analysis call.
#   4. `content_sha` is populated on every Evidence row for change-
#      detection on re-ingest.
#
# Prerequisites:
#   - docker-compose up -d (Postgres + Redis + MinIO).
#   - pnpm dev + pnpm worker running.
#   - APP_URL, SESSION_COOKIE, ASSESSMENT_ID, DATABASE_URL exported.
#
# Usage: bash scripts/smoke/smoke-ingest-shape.sh path/to/fixture.md
#
# Exit codes:
#   0 — pass.
#   1 — bad inputs / missing binaries / services unreachable.
#   2 — assertion failure (shape didn't match Week 1 expectations).
#   3 — timeout waiting for ingest to finish (bounded at 90s).

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

# Poll until ingest finishes — bounded so a wedged worker trips exit 3
# rather than hanging CI.
deadline=$((SECONDS + 90))
ingest_status=""
while [[ $SECONDS -lt $deadline ]]; do
    ingest_status=$(psql "$DATABASE_URL" -Atc \
        "SELECT ingest_status FROM documents WHERE id = '$document_id'")
    if [[ "$ingest_status" == "INGESTED" || "$ingest_status" == "READY" \
        || "$ingest_status" == "FAILED" ]]; then
        break
    fi
    sleep 1
done

if [[ -z "$ingest_status" ]]; then
    echo "[smoke] timed out waiting for ingest_status — worker wedged?" >&2
    exit 3
fi
if [[ "$ingest_status" != "INGESTED" && "$ingest_status" != "READY" ]]; then
    echo "[smoke] expected ingest_status in {INGESTED, READY}, got: $ingest_status" >&2
    exit 2
fi
echo "[smoke] ingest_status = $ingest_status"

# Assertion 1: chunking produced >1 Evidence rows per doc.
evidence_count=$(psql "$DATABASE_URL" -Atc \
    "SELECT COUNT(*) FROM evidences WHERE document_id = '$document_id'")
if [[ "${evidence_count:-0}" -le 1 ]]; then
    echo "[smoke] expected >1 Evidence row (chunking), got $evidence_count" >&2
    exit 2
fi
echo "[smoke] evidence rows: $evidence_count (chunking produced multiple rows)"

# Assertion 2: content_sha populated on every row.
null_sha_count=$(psql "$DATABASE_URL" -Atc \
    "SELECT COUNT(*) FROM evidences
      WHERE document_id = '$document_id'
        AND (content_sha IS NULL OR content_sha = '')")
if [[ "${null_sha_count:-0}" -ne 0 ]]; then
    echo "[smoke] $null_sha_count Evidence row(s) missing content_sha" >&2
    exit 2
fi
echo "[smoke] content_sha populated on all rows"

# Assertion 3: no AuditLog with callType='analysis' for the engagement.
# The engagement id is derived from the assessment so we can scope the
# check narrowly.
engagement_id=$(psql "$DATABASE_URL" -Atc \
    "SELECT engagement_id FROM assessments WHERE id = '$ASSESSMENT_ID'")
if [[ -z "$engagement_id" ]]; then
    echo "[smoke] couldn't resolve engagement for assessment $ASSESSMENT_ID" >&2
    exit 1
fi

analysis_audit_count=$(psql "$DATABASE_URL" -Atc "
    SELECT COUNT(*) FROM audit_logs al
      JOIN assessments a ON a.id = al.entity_id
     WHERE a.engagement_id = '$engagement_id'
       AND al.details->>'callType' = 'analysis'
       AND al.created_at > NOW() - INTERVAL '5 minutes'")
if [[ "${analysis_audit_count:-0}" -ne 0 ]]; then
    echo "[smoke] unexpected callType=analysis audit rows: $analysis_audit_count" >&2
    echo "[smoke] ingest leaked into AI analysis — Week 1 decoupling broken" >&2
    exit 2
fi
echo "[smoke] no callType=analysis audit rows (ingest did not call AI)"

echo "[smoke] PASS"
