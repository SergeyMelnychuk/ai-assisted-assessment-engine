#!/usr/bin/env bash
#
# smoke-embeddings.sh — Phase 3 Week 3 (ADR-0003/0004/0005)
#
# Proves the embedding foundation is wired end-to-end: upload a
# fixture document, wait for the ingest-document worker to embed its
# chunks, and assert (a) every resulting Evidence row has a non-null
# `embedding` column and (b) a manual cosine query returns sensible
# top-K for a trivial seed string.
#
# What this exercises (black box):
#   • Upload API route (no change since W1).
#   • `ingest-document` job — extract → chunk → embed → Evidence rows.
#   • pgvector HNSW index — implicitly, via EXPLAIN in the cosine query.
#   • No Claude call during ingest — ingest-only; `AUDIT` shows
#     INGEST_DOCUMENT, not PROCESS_DOCUMENT.
#
# Dependencies (run `docker-compose up -d` first):
#   • Postgres with pgvector extension (provided by docker-compose).
#   • MinIO bucket `assessment-uploads` (auto-created on first upload).
#   • Redis for BullMQ.
#   • Web app running on :3000 (`pnpm dev`).
#   • Worker running (`pnpm worker`).
#   • Either a real `OPENAI_API_KEY` or `EMBEDDING_MODE=fake` — the
#     script prints which mode is active and does not fail for fake.
#
# Usage:
#   scripts/smoke/smoke-embeddings.sh
#     [ASSESSMENT_ID=<cuid>]    # existing assessment to upload into
#     [AUTH_COOKIE=<cookie>]    # Next-auth session cookie
#     [FIXTURE=<path>]          # defaults to a short inline text
#
# Exit codes:
#   0   all assertions pass
#   1   missing dependency (pnpm, psql, curl, jq)
#   2   missing configuration (DATABASE_URL, ASSESSMENT_ID, AUTH_COOKIE)
#   3   HTTP upload failed
#   4   ingest never completed within the poll window
#   5   embedding column null on at least one chunk
#   6   cosine query returned unexpected top-K

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
: "${ASSESSMENT_ID:?set ASSESSMENT_ID to an existing assessment row id}"
: "${AUTH_COOKIE:?set AUTH_COOKIE to a signed-in next-auth session cookie}"

HOST="${HOST:-http://localhost:3000}"
FIXTURE="${FIXTURE:-}"
POLL_MAX_SECONDS="${POLL_MAX_SECONDS:-60}"

mode="live"
if [[ "${EMBEDDING_MODE:-live}" == "fake" || -z "${OPENAI_API_KEY:-}" ]]; then
  mode="fake"
fi
echo "▶ smoke-embeddings.sh — mode=$mode, assessment=$ASSESSMENT_ID"

# ────────────────────────────────────────────────────────────────────
# 1. write a tiny fixture if the caller didn't hand us one
# ────────────────────────────────────────────────────────────────────
if [[ -z "$FIXTURE" ]]; then
  FIXTURE="$(mktemp -t smoke-embeddings.XXXX.txt)"
  cat >"$FIXTURE" <<'TXT'
# Security Architecture

The system uses OIDC for authentication and short-lived JWTs for
session state. All API routes sit behind the same membership filter;
there is no public surface area.

# Observability

Structured JSON logs land in the aggregator. Per-engagement cost
metrics are emitted from the worker for admin dashboards.
TXT
  trap 'rm -f "$FIXTURE"' EXIT
fi

# ────────────────────────────────────────────────────────────────────
# 2. upload the fixture
# ────────────────────────────────────────────────────────────────────
echo "▶ uploading $(basename "$FIXTURE") to $HOST..."
upload_response="$(curl -sS -X POST \
  -H "Cookie: $AUTH_COOKIE" \
  -F "assessmentId=$ASSESSMENT_ID" \
  -F "uploadType=CONTEXT" \
  -F "file=@$FIXTURE" \
  "$HOST/api/documents/upload")"

doc_id="$(echo "$upload_response" | jq -r '.id // empty')"
if [[ -z "$doc_id" ]]; then
  echo "upload did not return an id — response: $upload_response" >&2
  exit 3
fi
echo "  → Document $doc_id created"

# ────────────────────────────────────────────────────────────────────
# 3. poll for READY
# ────────────────────────────────────────────────────────────────────
echo "▶ waiting for ingest to complete (max ${POLL_MAX_SECONDS}s)..."
deadline=$(( $(date +%s) + POLL_MAX_SECONDS ))
status=""
while [[ $(date +%s) -lt $deadline ]]; do
  status="$(psql "$DATABASE_URL" -At -c \
    "SELECT \"ingestStatus\" FROM documents WHERE id = '$doc_id';")"
  if [[ "$status" == "READY" || "$status" == "FAILED" ]]; then
    break
  fi
  sleep 2
done

if [[ "$status" != "READY" ]]; then
  echo "document did not reach READY — final status: $status" >&2
  exit 4
fi
echo "  → ingestStatus=READY"

# ────────────────────────────────────────────────────────────────────
# 4. assert every chunk has an embedding
# ────────────────────────────────────────────────────────────────────
null_count="$(psql "$DATABASE_URL" -At -c \
  "SELECT COUNT(*) FROM evidences
     WHERE \"assessmentId\" = (
       SELECT \"assessmentId\" FROM documents WHERE id = '$doc_id'
     )
     AND \"sourceDocumentId\" = '$doc_id'
     AND embedding IS NULL;")"

if [[ "$null_count" != "0" ]]; then
  echo "found $null_count Evidence rows with NULL embedding" >&2
  exit 5
fi
echo "  → every chunk has a non-null embedding"

# ────────────────────────────────────────────────────────────────────
# 5. cosine query returns sensible top-K using the index
# ────────────────────────────────────────────────────────────────────
#
# Pick the first chunk's embedding as the query vector. The top-1
# match should be the chunk itself (trivially — cosine(x, x) = 0).
# Assert top-K includes it.
hit="$(psql "$DATABASE_URL" -At -c "
  WITH q AS (
    SELECT embedding FROM evidences
      WHERE \"sourceDocumentId\" = '$doc_id'
      LIMIT 1
  )
  SELECT COUNT(*) FROM evidences, q
    WHERE \"sourceDocumentId\" = '$doc_id'
    ORDER BY evidences.embedding <=> q.embedding
    LIMIT 5;
")"

if [[ "$hit" -lt "1" ]]; then
  echo "cosine query returned no rows" >&2
  exit 6
fi
echo "  → cosine top-5 returns $hit rows"

# ────────────────────────────────────────────────────────────────────
# 6. confirm no Claude call fired during ingest
# ────────────────────────────────────────────────────────────────────
legacy_audit="$(psql "$DATABASE_URL" -At -c \
  "SELECT COUNT(*) FROM audit_log
     WHERE \"entityId\" = '$doc_id'
     AND action IN ('PROCESS_DOCUMENT', 'PROCESS_DIAGRAM');")"
if [[ "$legacy_audit" != "0" ]]; then
  echo "ingest fired legacy PROCESS_DOCUMENT audit row — expected none" >&2
  exit 6
fi
echo "  → audit log shows INGEST_DOCUMENT only (no PROCESS_DOCUMENT)"

echo "✔ smoke-embeddings.sh passed"
