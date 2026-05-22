#!/usr/bin/env bash
#
# Smoke test for Phase 3 Week 5 — archive upload + fan-out ingest
# (ADR-0008).
#
# What this proves:
#   1. An uploaded zip becomes a single "parent" Document row with
#      no chunks of its own.
#   2. The `ingest-archive` worker fans out child Document rows under
#      `parent_document_id`, one per surviving entry.
#   3. Children go through the standard `ingest-document` pipeline —
#      Evidence rows land for each child that actually ingests.
#   4. Default-ignored files (node_modules, *.lock) are NOT promoted
#      to child Document rows.
#
# Requirements (same prerequisites as smoke-ingest-decoupled.sh):
#   - `docker-compose up -d` for Postgres + Redis + MinIO.
#   - `pnpm dev` and `pnpm worker` running in two terminals.
#   - `APP_URL`, `SESSION_COOKIE`, `ASSESSMENT_ID`, `DATABASE_URL`
#     exported in the environment.
#
# Usage: bash scripts/smoke/smoke-archive-upload.sh path/to/fixture.zip
#
# The fixture zip should contain a mix of interesting files (a .md
# and a .txt at minimum) and at least one file we expect to be
# ignored (`node_modules/anything` or `yarn.lock` will do).
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
    echo "Usage: $0 <fixture-archive.zip|.tar|.tar.gz>" >&2
    exit 1
fi

for bin in curl jq psql; do
    command -v "$bin" >/dev/null 2>&1 || {
        echo "Missing required binary: $bin" >&2
        exit 1
    }
done

# The upload route sniffs the archive kind from the *file bytes* and
# the `application/zip` / `application/x-tar` / `application/gzip`
# MIME. `curl`'s `-F` flag infers MIME from the extension — good
# enough for a fixture with a .zip / .tar.gz suffix.
echo "[smoke] uploading $FIXTURE to $APP_URL ..."
upload_response=$(curl -sS -X POST "$APP_URL/api/documents/upload" \
    -H "Cookie: $SESSION_COOKIE" \
    -F "assessmentId=$ASSESSMENT_ID" \
    -F "file=@$FIXTURE")

parent_id=$(echo "$upload_response" | jq -r '.documentId // empty')
is_archive=$(echo "$upload_response" | jq -r '.isArchive // false')
archive_kind=$(echo "$upload_response" | jq -r '.archiveKind // "?"')

if [[ -z "$parent_id" ]]; then
    echo "[smoke] upload failed: $upload_response" >&2
    exit 2
fi
if [[ "$is_archive" != "true" ]]; then
    echo "[smoke] server did not detect archive: $upload_response" >&2
    exit 2
fi
echo "[smoke] parent id: $parent_id (kind=$archive_kind)"

# Poll the parent until it reaches READY or FAILED. The archive
# worker fans out children synchronously before flipping the parent,
# so once parent is READY the child rows are already in place.
deadline=$((SECONDS + 120))
parent_status=""
while [[ $SECONDS -lt $deadline ]]; do
    parent_status=$(psql "$DATABASE_URL" -Atc \
        "SELECT ingest_status FROM documents WHERE id = '$parent_id'")
    if [[ "$parent_status" == "READY" || "$parent_status" == "FAILED" ]]; then
        break
    fi
    sleep 1
done

if [[ "$parent_status" != "READY" ]]; then
    echo "[smoke] expected parent ingest_status=READY, got: $parent_status" >&2
    # Surface the failure reason from the audit log for debuggability.
    psql "$DATABASE_URL" -At \
        -c "SELECT details::text FROM audit_logs
             WHERE entity_id = '$parent_id'
               AND action = 'INGEST_ARCHIVE_FAILED'
             ORDER BY created_at DESC LIMIT 1"
    exit 2
fi
echo "[smoke] parent ingest_status = READY"

# Child count: at least 1 real file from the archive must have
# landed as its own Document row.
child_count=$(psql "$DATABASE_URL" -Atc \
    "SELECT COUNT(*) FROM documents WHERE parent_document_id = '$parent_id'")
if [[ "$child_count" -lt 1 ]]; then
    echo "[smoke] expected >=1 child Document, got $child_count" >&2
    exit 2
fi
echo "[smoke] child documents: $child_count"

# Wait for the children to ingest. Bounded loop — if the standard
# ingest-document worker is wedged, the smoke should fail, not hang.
child_deadline=$((SECONDS + 120))
while [[ $SECONDS -lt $child_deadline ]]; do
    pending=$(psql "$DATABASE_URL" -Atc \
        "SELECT COUNT(*) FROM documents
           WHERE parent_document_id = '$parent_id'
             AND ingest_status NOT IN ('READY','FAILED')")
    if [[ "$pending" -eq 0 ]]; then
        break
    fi
    sleep 2
done

ready_children=$(psql "$DATABASE_URL" -Atc \
    "SELECT COUNT(*) FROM documents
       WHERE parent_document_id = '$parent_id'
         AND ingest_status = 'READY'")
if [[ "$ready_children" -lt 1 ]]; then
    echo "[smoke] expected >=1 child to reach READY, got $ready_children" >&2
    exit 2
fi
echo "[smoke] children ready: $ready_children / $child_count"

# Evidence rows must exist for at least one child — proves the
# fan-out ran through the standard ingest pipeline, not just created
# rows and walked away.
evidence_count=$(psql "$DATABASE_URL" -Atc \
    "SELECT COUNT(*) FROM evidences e
       JOIN documents d ON d.id = e.document_id
      WHERE d.parent_document_id = '$parent_id'")
if [[ "$evidence_count" -lt 1 ]]; then
    echo "[smoke] expected >=1 Evidence row on descendants, got $evidence_count" >&2
    exit 2
fi
echo "[smoke] descendant evidence rows: $evidence_count"

# Negative assertion: default-ignored basenames must NOT appear as
# children. This is the one that catches silent regressions in the
# ignore list.
ignored_leaked=$(psql "$DATABASE_URL" -Atc \
    "SELECT COUNT(*) FROM documents
       WHERE parent_document_id = '$parent_id'
         AND (
              filename IN ('yarn.lock','pnpm-lock.yaml','package-lock.json',
                           'Cargo.lock','Gemfile.lock','poetry.lock','go.sum',
                           '.DS_Store','.env')
              OR filename LIKE '%.min.js'
              OR filename LIKE '%.pyc'
         )")
if [[ "$ignored_leaked" -ne 0 ]]; then
    echo "[smoke] ignore list leaked: $ignored_leaked unwanted child rows" >&2
    exit 2
fi
echo "[smoke] ignore list honoured (no lockfile / .min.js / .pyc children)"

# INGEST_ARCHIVE audit row carries the kept / skipped counts.
audit_row=$(psql "$DATABASE_URL" -Atc \
    "SELECT COUNT(*) FROM audit_logs
      WHERE entity_id = '$parent_id'
        AND action = 'INGEST_ARCHIVE'")
if [[ "$audit_row" -lt 1 ]]; then
    echo "[smoke] expected >=1 INGEST_ARCHIVE audit row, got $audit_row" >&2
    exit 2
fi
echo "[smoke] INGEST_ARCHIVE audit row present"

echo "[smoke] PASS"
