#!/usr/bin/env bash
#
# smoke-repo-link.sh — Phase 3 Week 6 (ADR-0009 / 0010)
#
# End-to-end proof that repository linking works:
#   1. Create a RepositoryLink against a small public GitHub repo
#      (PAT required — public-repo read works with any PAT, including
#      a stripped-to-no-scope fine-grained token).
#   2. Poll for `ingestStatus=READY`.
#   3. Assert child Documents exist with `parentDocumentId` pointing at
#      the link's archive row, and Evidence rows carry a language tag
#      in `chunkSource`.
#   4. Secret-scan: grep the audit_log for the plaintext PAT. Fail if
#      it appears anywhere.
#
# What this exercises (black box):
#   • tRPC `repositoryLink.create` — credential encryption round-trip.
#   • `ingest-repository` worker — tarball fetch → MinIO → ingest-archive.
#   • Week 5 archive pipeline — safety gates, .gitignore / blacklist,
#     fan-out to per-file `ingest-document`.
#   • Week 3 embedding pipeline — child docs produce embedded Evidence.
#   • Week 6 audit-log scrubbing — scrubCredential must leave no PAT
#     trace in `audit_log.details`.
#
# Dependencies (run `docker-compose up -d` first):
#   • Postgres 16 + pgvector.
#   • Redis 7 for BullMQ.
#   • MinIO for `repo-archives/*` sink.
#   • Web app on :3000 (`pnpm dev`) + worker (`pnpm worker`).
#   • Either a real `REPO_CREDENTIAL_KEY` (32 bytes base64) or
#     `REPO_CREDENTIAL_MODE=fake` for CI.
#
# Usage:
#   scripts/smoke/smoke-repo-link.sh
#     [ASSESSMENT_ID=<cuid>]    # existing assessment row
#     [AUTH_COOKIE=<cookie>]    # NextAuth session cookie
#     [REPO_URL=<url>]          # default: small public repo fixture
#     [GITHUB_PAT=<token>]      # required; any read-only PAT works
#
# Exit codes:
#   0   all assertions pass
#   1   missing dependency (curl, jq, psql)
#   2   missing configuration
#   3   tRPC create failed
#   4   ingest never reached READY within the poll window
#   5   no child Documents / Evidence landed
#   6   Evidence missing `chunkSource.language`
#   7   plaintext PAT found in audit_log.details — HARD FAIL

set -euo pipefail

# ─── 0. dependency check ─────────────────────────────────────────────
for bin in curl jq psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "missing dependency: $bin" >&2
    exit 1
  fi
done

: "${DATABASE_URL:?set DATABASE_URL (e.g. postgres://copilot:copilot@localhost:5432/copilot)}"
: "${ASSESSMENT_ID:?set ASSESSMENT_ID to an existing assessment row id}"
: "${AUTH_COOKIE:?set AUTH_COOKIE to a signed-in next-auth session cookie}"
: "${GITHUB_PAT:?set GITHUB_PAT to a read-only PAT (any fine-grained token works for public repos)}"

HOST="${HOST:-http://localhost:3000}"
REPO_URL="${REPO_URL:-https://github.com/anthropics/courses}"
POLL_MAX_SECONDS="${POLL_MAX_SECONDS:-180}"

echo "▶ smoke-repo-link.sh — assessment=$ASSESSMENT_ID repo=$REPO_URL"

# ─── 1. call repositoryLink.create via tRPC ──────────────────────────
#
# tRPC v11 HTTP batching shape. We bypass the client for a
# dependency-free curl. Note the PAT is in the request body only —
# the response shape includes no credential field (by design).
echo "▶ creating RepositoryLink..."
payload=$(jq -n \
  --arg a "$ASSESSMENT_ID" \
  --arg u "$REPO_URL" \
  --arg p "$GITHUB_PAT" \
  '{"0":{"json":{"assessmentId":$a,"url":$u,"pat":$p}}}')

create_response="$(curl -sS -X POST \
  -H "Cookie: $AUTH_COOKIE" \
  -H "Content-Type: application/json" \
  --data "$payload" \
  "$HOST/api/trpc/repositoryLink.create?batch=1")"

link_id="$(echo "$create_response" | jq -r '.[0].result.data.json.id // empty')"
if [[ -z "$link_id" ]]; then
  echo "create did not return an id — response: $create_response" >&2
  exit 3
fi
echo "  → RepositoryLink $link_id created"

# ─── 2. poll for READY ───────────────────────────────────────────────
echo "▶ waiting for ingest to reach READY (max ${POLL_MAX_SECONDS}s)..."
deadline=$(( $(date +%s) + POLL_MAX_SECONDS ))
status=""
while [[ $(date +%s) -lt $deadline ]]; do
  status="$(psql "$DATABASE_URL" -At -c \
    "SELECT \"ingest_status\" FROM repository_links WHERE id = '$link_id';")"
  if [[ "$status" == "READY" || "$status" == "FAILED" ]]; then
    break
  fi
  sleep 3
done

if [[ "$status" != "READY" ]]; then
  echo "link did not reach READY — final status: $status" >&2
  exit 4
fi
echo "  → ingestStatus=READY"

# ─── 3. assert child Documents + Evidence landed ─────────────────────
child_doc_count="$(psql "$DATABASE_URL" -At -c \
  "SELECT COUNT(*) FROM documents
     WHERE \"parent_document_id\" = (
       SELECT \"parent_document_id\" FROM repository_links WHERE id = '$link_id'
     );")"

if [[ "$child_doc_count" == "0" || -z "$child_doc_count" ]]; then
  echo "no child Documents found for link $link_id" >&2
  exit 5
fi
echo "  → $child_doc_count child Documents ingested"

ev_count="$(psql "$DATABASE_URL" -At -c \
  "SELECT COUNT(*) FROM evidences
     WHERE \"sourceDocumentId\" IN (
       SELECT id FROM documents
         WHERE \"parent_document_id\" = (
           SELECT \"parent_document_id\" FROM repository_links WHERE id = '$link_id'
         )
     );")"

if [[ "$ev_count" == "0" || -z "$ev_count" ]]; then
  echo "no Evidence rows landed for link $link_id" >&2
  exit 5
fi
echo "  → $ev_count Evidence rows landed"

# ─── 4. assert chunkSource.language is populated ─────────────────────
lang_missing="$(psql "$DATABASE_URL" -At -c \
  "SELECT COUNT(*) FROM evidences
     WHERE \"sourceDocumentId\" IN (
       SELECT id FROM documents
         WHERE \"parent_document_id\" = (
           SELECT \"parent_document_id\" FROM repository_links WHERE id = '$link_id'
         )
     )
     AND (chunk_source IS NULL OR NOT (chunk_source ? 'language'));")"

if [[ "$lang_missing" != "0" ]]; then
  echo "$lang_missing Evidence rows missing chunkSource.language" >&2
  exit 6
fi
echo "  → every chunk carries a chunkSource.language tag"

# ─── 5. secret-scan the audit log — PAT must never appear ────────────
#
# This is the most important assertion in the script. The W6 audit
# path goes through `scrubCredential`; if that ever regresses, PATs
# would leak into AuditLog.details. We grep the raw JSON.
pat_hit="$(psql "$DATABASE_URL" -At -c \
  "SELECT COUNT(*) FROM audit_log
     WHERE details::text LIKE '%${GITHUB_PAT}%';")"

if [[ "$pat_hit" != "0" ]]; then
  echo "❌ plaintext PAT found in $pat_hit audit_log rows — SECURITY REGRESSION" >&2
  exit 7
fi
echo "  → audit_log is PAT-free"

echo "✔ smoke-repo-link.sh passed"
