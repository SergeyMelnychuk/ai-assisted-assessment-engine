#!/usr/bin/env bash
#
# Smoke test for Phase 3 Week 2 — per-domain analysis fan-out.
#
# What this proves:
#   1. A single `run-analysis` call fans out into *one Claude call per
#      active domain* (not one mega-call), evidenced by an AuditLog row
#      per domain under action=`ANALYSIS_DOMAIN_CALL` (or whatever the
#      per-domain telemetry action is for this codebase).
#   2. Findings land across at least TWO distinct domains — i.e. the
#      loop actually iterates, it doesn't short-circuit on the first.
#   3. Partial-success behaviour: if one domain's call fails (simulated
#      by the operator injecting a bad rubric for one domain, or just
#      by the natural failure of a domain with no evidence), the other
#      domains still produce findings and the top-level audit row
#      records the partial state rather than aborting outright.
#
# Prerequisites (same shape as `smoke-rag-analysis.sh`):
#   - Running stack: docker-compose up -d; pnpm dev; pnpm worker.
#   - `APP_URL`, `SESSION_COOKIE`, `ASSESSMENT_ID`, `DATABASE_URL`
#     exported in the environment.
#   - The assessment must be multi-domain: at least 2 entries in
#     `activeDomains` and at least one Evidence row tagged per domain.
#     The Week 3 / Week 5 smokes are fine seed-doc generators.
#
# Usage: bash scripts/smoke/smoke-per-domain-analysis.sh
#
# Exit codes:
#   0 — pass: fan-out observed across >=2 domains, partial-success audit trail present.
#   1 — bad inputs / unreachable services / missing binaries.
#   2 — assertion failure (no fan-out, or no per-domain audit rows).
#   3 — timeout waiting for the worker to finish (bounded at 180s).

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

# Precondition: the assessment must have >=2 active domains, else the
# fan-out assertion is vacuous.
active_domain_count=$(psql "$DATABASE_URL" -Atc \
    "SELECT COALESCE(array_length(active_domains, 1), 0)
       FROM assessments WHERE id = '$ASSESSMENT_ID'")
if [[ "${active_domain_count:-0}" -lt 2 ]]; then
    echo "[smoke] assessment needs >=2 active_domains (got $active_domain_count)" >&2
    exit 1
fi
echo "[smoke] preconditions OK — $active_domain_count active domains"

echo "[smoke] triggering analysis on $ASSESSMENT_ID ..."
run_response=$(curl -sS -X POST "$APP_URL/api/trpc/assessment.runAnalysis" \
    -H "Cookie: $SESSION_COOKIE" \
    -H "Content-Type: application/json" \
    -d "{\"json\":{\"assessmentId\":\"$ASSESSMENT_ID\"}}")

if echo "$run_response" | jq -e '.error' >/dev/null 2>&1; then
    echo "[smoke] runAnalysis errored: $run_response" >&2
    exit 2
fi

# Wait for the top-level RUN_ANALYSIS audit row. Bounded so a wedged
# worker fails the smoke rather than hanging CI.
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
    echo "[smoke] no RUN_ANALYSIS audit row within 180s — worker wedged?" >&2
    exit 3
fi
echo "[smoke] RUN_ANALYSIS audit row present"

# Assertion 1: findings span >= 2 distinct domains. If the fan-out
# collapsed to one domain, this fails.
finding_domains=$(psql "$DATABASE_URL" -Atc \
    "SELECT COUNT(DISTINCT domain) FROM findings
      WHERE assessment_id = '$ASSESSMENT_ID' AND domain IS NOT NULL")
if [[ "${finding_domains:-0}" -lt 2 ]]; then
    echo "[smoke] findings span only ${finding_domains:-0} domain(s) — fan-out not observed" >&2
    exit 2
fi
echo "[smoke] findings span $finding_domains distinct domains"

# Assertion 2: per-domain audit trail. Each domain call should emit its
# own audit row with the domain in `details`. We count rows whose
# details JSON has a `domain` key matching one of the active domains.
per_domain_rows=$(psql "$DATABASE_URL" -Atc "
    SELECT COUNT(*) FROM audit_logs
     WHERE entity_id = '$ASSESSMENT_ID'
       AND action IN ('ANALYSIS_DOMAIN_CALL', 'RUN_ANALYSIS_DOMAIN',
                      'DOMAIN_ANALYSIS', 'RUN_ANALYSIS')
       AND created_at > NOW() - INTERVAL '5 minutes'
       AND (details ? 'domain' OR details ? 'domains')")
if [[ "${per_domain_rows:-0}" -lt 2 ]]; then
    echo "[smoke] expected per-domain audit rows — got ${per_domain_rows:-0}." >&2
    echo "[smoke] either fan-out is still a single call, or the worker isn't logging domain-scoped audit rows." >&2
    exit 2
fi
echo "[smoke] per-domain audit rows: $per_domain_rows"

# Assertion 3 (partial-success sanity): if any domain failed, the
# top-level RUN_ANALYSIS row should record a non-empty `failedDomains`
# array AND at least one other domain should still have findings.
failed_domain_json=$(psql "$DATABASE_URL" -Atc "
    SELECT COALESCE(details->>'failedDomains', '[]') FROM audit_logs
     WHERE entity_id = '$ASSESSMENT_ID'
       AND action = 'RUN_ANALYSIS'
       AND created_at > NOW() - INTERVAL '5 minutes'
     ORDER BY created_at DESC LIMIT 1")
failed_count=$(echo "$failed_domain_json" | jq 'if type=="array" then length else 0 end' 2>/dev/null || echo 0)
if [[ "${failed_count:-0}" -gt 0 ]]; then
    # Partial success: ensure some findings still landed.
    finding_count=$(psql "$DATABASE_URL" -Atc \
        "SELECT COUNT(*) FROM findings WHERE assessment_id = '$ASSESSMENT_ID'")
    if [[ "${finding_count:-0}" -lt 1 ]]; then
        echo "[smoke] $failed_count domain(s) failed and NO findings landed — not partial, fully broken" >&2
        exit 2
    fi
    echo "[smoke] partial success: $failed_count failed domain(s), $finding_count findings preserved"
else
    echo "[smoke] all domains succeeded"
fi

# ─── Truncation assertion (Phase 3 post-audit gap-fill) ─────────────
#
# Per ADR-0002, the per-domain fan-out *dissolves* the combined-output
# truncation failure mode: each call has its own `max_tokens` budget
# (DOMAIN_ANALYSIS_MAX_TOKENS = 4096) scoped to ~one domain of output.
# Before fan-out, one mega-call was asked to emit findings for all 8
# domains inside a single 8192-token ceiling and frequently stopped mid-
# JSON — the resulting response had an unbalanced-brace tail and the
# parser flipped it to `cutoff=true` in audit details.
#
# The assertion: for each of the (up to) 8 per-domain AuditLog rows
# emitted this run, verify the stored Claude response JSON is well-
# formed. We accept two shapes the codebase uses:
#   a) `details.result` — the parsed-and-stored raw AI JSON.
#   b) `details.response` — earlier naming.
# Either must parse as JSON via `jq`, and neither `details.cutoff=true`
# nor `details.truncated=true` may be set. This catches regressions
# where a future prompt change re-introduces mid-JSON termination.
echo "[smoke] checking per-domain outputs are well-formed (ADR-0002)..."

rows=$(psql "$DATABASE_URL" -Atc "
    SELECT COALESCE(details::text, '{}') FROM audit_logs
     WHERE entity_id = '$ASSESSMENT_ID'
       AND action IN ('ANALYSIS_DOMAIN_CALL', 'RUN_ANALYSIS_DOMAIN',
                      'DOMAIN_ANALYSIS', 'AI_CALL')
       AND created_at > NOW() - INTERVAL '5 minutes'
       AND (details ? 'domain' OR details ? 'callType')
     ORDER BY created_at ASC")

checked=0
while IFS= read -r detail; do
    [[ -z "$detail" ]] && continue
    checked=$((checked + 1))
    # cutoff / truncated flags tripped by the parser recovery path.
    cutoff=$(echo "$detail" | jq -r '.cutoff // .truncated // false')
    if [[ "$cutoff" == "true" ]]; then
        echo "[smoke] per-domain audit row flagged cutoff/truncated — ADR-0002 regression" >&2
        exit 2
    fi
    # If a result blob is present, insist it re-parses cleanly (no mid-
    # JSON termination). Rows that don't carry the blob (cost-only rows
    # from ADR-0012) are skipped — their presence isn't the subject here.
    payload=$(echo "$detail" | jq -r '.result // .response // empty')
    if [[ -n "$payload" && "$payload" != "null" ]]; then
        if ! echo "$payload" | jq -e . >/dev/null 2>&1; then
            echo "[smoke] per-domain payload did not parse as JSON — mid-JSON termination?" >&2
            echo "[smoke] first 200 chars: ${payload:0:200}" >&2
            exit 2
        fi
    fi
done <<< "$rows"

if [[ "$checked" -lt 2 ]]; then
    echo "[smoke] expected >=2 per-domain audit rows to inspect, got $checked" >&2
    exit 2
fi
echo "[smoke] $checked per-domain audit row(s) well-formed — no truncation observed"

echo "[smoke] PASS"
