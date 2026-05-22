import { db } from "@/server/db";
import { runAnalysis } from "@/server/services/analysis-engine";
import { runDomainScoring } from "@/server/services/scoring-service";
import { classifyProcessingError } from "@/server/services/ai/error-classifier";
import {
  isAnalysisCancelRequested,
  isCancelledError,
  throwIfCancelled,
} from "@/server/services/cancellation";
import type { AnalysisMode } from "@/server/services/analysis-mode";

/**
 * Post-analysis target state — the assessment advances to `DRAFTING`
 * once the AI passes have landed (partial or full success). Before the
 * fix for the "stuck ANALYSIS" bug, the worker only flipped *into*
 * ANALYSIS at start and never out of it, leaving every successful run
 * wedged in the analysis banner state (repro: assessment
 * cmo4w3nmv000bv8dud4k23qmr — `RUN_ANALYSIS` audit row at 17:39:33Z
 * with `status = ANALYSIS` still set). `DRAFTING` matches the
 * AssessmentStage enum order (SETUP → INTAKE → QUESTIONING →
 * ANALYSIS → DRAFTING → REVIEW → COMPLETED) — it's the stage the UI
 * expects once findings/risks/recommendations exist and the reviewer
 * starts curating them. We reuse the same target on the failed /
 * cancelled paths so the user can retry without getting stuck in a
 * dedicated failure stage the UI doesn't know about.
 */
const POST_ANALYSIS_STAGE = "DRAFTING" as const;

/**
 * Orchestrates the two AI passes that make up an assessment analysis:
 *
 *   1. Findings / risks / recommendations / assumptions (fanned out per
 *      active domain — Phase 3 Week 2, ADR-0002).
 *   2. Domain scoring (also per-domain since Week 2).
 *
 * Each pass runs one Claude call per active domain with bounded
 * concurrency. Domains fail independently; a partial success (some
 * domains ok, some failed) writes a single `RUN_ANALYSIS` audit-log
 * row whose `details.domains` carries per-domain status. If **every**
 * domain failed in both passes we treat the run as a hard failure and
 * fall through to the `RUN_ANALYSIS_FAILED` path so the FailureBanner
 * surfaces the classified error.
 */
export async function runAnalysisJob(
  assessmentId: string,
  mode: AnalysisMode = "FAST",
): Promise<void> {
  const started = Date.now();
  const startedAt = new Date(started);
  console.log(`[run-analysis] ▶ assessment=${assessmentId} mode=${mode}`);

  // Polled by the per-domain fan-out inside `runAnalysis` /
  // `runDomainScoring`. One audit-log `findFirst` per domain — cheap
  // next to the 30-60s Claude calls it gates. See
  // `services/cancellation.ts` for the protocol rationale.
  const shouldCancel = () =>
    isAnalysisCancelRequested(db, assessmentId, startedAt);

  // Flip the assessment to ANALYSIS so the UI can render a banner. If
  // the AI call fails the UI still reflects the attempted state — the
  // user can trigger a retry.
  await db.assessment
    .update({
      where: { id: assessmentId },
      data: { status: "ANALYSIS" },
    })
    .catch(() => {
      // Assessment gone → bail silently.
    });

  try {
    // Pre-flight cancel check — a user can cancel while the job sits
    // in the queue waiting for a worker slot.
    await throwIfCancelled(db, assessmentId, startedAt);

    const findingsRes = await runAnalysis(
      db,
      assessmentId,
      undefined,
      shouldCancel,
      mode,
    );
    console.log(
      `[run-analysis] findings=${findingsRes.findingsCreated} risks=${findingsRes.risksCreated} recs=${findingsRes.recommendationsCreated} assumptions=${findingsRes.assumptionsCreated}`,
    );

    // Between-phase check — if the user cancelled during analysis,
    // skip scoring entirely rather than running 8 more Claude calls.
    await throwIfCancelled(db, assessmentId, startedAt);

    const scoringRes = await runDomainScoring(
      db,
      assessmentId,
      undefined,
      shouldCancel,
    );
    console.log(
      `[run-analysis] scored=${scoringRes.scored}${scoringRes.skippedLockedDomains ? ` skipped-locked=${scoringRes.skippedLockedDomains}` : ""}`,
    );

    // Aggregate per-domain status from both passes into one compact map
    // suitable for `AuditLog.details`. The UI can reuse
    // `FailureBanner` for any domain whose status came back `failed`
    // without blocking the succeeded siblings.
    const analysisByDomain: Record<string, "ok" | "failed"> = {};
    const scoringByDomain: Record<string, "ok" | "failed"> = {};
    // Verifier leg (Reviewed/THOROUGH mode only). Populated per domain
    // in the engine; omitted entirely in FAST so the audit row doesn't
    // carry a spurious empty object and the UI can tell "no verifier
    // ran" from "verifier ran but every domain failed".
    const verifyByDomain: Record<string, "ok" | "failed"> = {};
    const failedDomains: Array<{
      domain: string;
      phase: "analysis" | "scoring";
      error: string;
    }> = [];
    for (const d of findingsRes.perDomain) {
      analysisByDomain[d.domain] = d.status;
      if (d.verify === "ok" || d.verify === "failed") {
        verifyByDomain[d.domain] = d.verify;
      }
      if (d.status === "failed" && d.error) {
        failedDomains.push({ domain: d.domain, phase: "analysis", error: d.error });
      }
    }
    for (const d of scoringRes.perDomain) {
      scoringByDomain[d.domain] = d.status;
      if (d.status === "failed" && d.error) {
        failedDomains.push({ domain: d.domain, phase: "scoring", error: d.error });
      }
    }

    const totalDomains =
      findingsRes.perDomain.length + scoringRes.perDomain.length;
    const okDomains =
      findingsRes.perDomain.filter((d) => d.status === "ok").length +
      scoringRes.perDomain.filter((d) => d.status === "ok").length;
    const anyFailed = failedDomains.length > 0;
    const allFailed = totalDomains > 0 && okDomains === 0;

    // Post-fan-out cancel check — the per-domain short-circuits return
    // synthetic `{status: "failed", error: "cancelled"}` entries, so a
    // mid-scoring cancel falls through to here without throwing. If we
    // see a cancel request we escalate to `CancelledError` so the
    // unified "cancelled" terminal row gets written (instead of
    // misleading partial-failure details).
    await throwIfCancelled(db, assessmentId, startedAt);

    // If every call failed we propagate through the catch handler below
    // so the existing classifier/FailureBanner path kicks in. The first
    // error is representative enough for the banner.
    if (allFailed) {
      throw new Error(
        `all per-domain analysis calls failed: ${failedDomains[0]?.error ?? "unknown"}`,
      );
    }

    // Single aggregated audit row — matches the "one final audit-log
    // row" contract in the Week 2 roadmap. Per-domain status lives in
    // `details.domains` so `analysis.lastFailure` and future dashboards
    // can grep it without re-running the analysis.
    await db.auditLog.create({
      data: {
        action: "RUN_ANALYSIS",
        entityType: "Assessment",
        entityId: assessmentId,
        details: {
          // High-level counts survive for backwards-compat with the
          // MVP audit schema.
          mode,
          findings: findingsRes.findingsCreated,
          risks: findingsRes.risksCreated,
          recommendations: findingsRes.recommendationsCreated,
          assumptions: findingsRes.assumptionsCreated,
          scored: scoringRes.scored,
          skippedLockedDomains: scoringRes.skippedLockedDomains ?? 0,
          tokens: {
            analysis: findingsRes.tokensUsed ?? null,
            scoring: scoringRes.tokensUsed ?? null,
          },
          // Week 2 additions — per-domain status map + failure summary.
          domains: {
            analysis: analysisByDomain,
            scoring: scoringByDomain,
            // Only stamped in Reviewed/THOROUGH runs. Absent key ⇒ the
            // badge omits the Verify leg (ADR-0013).
            ...(Object.keys(verifyByDomain).length > 0
              ? { verify: verifyByDomain }
              : {}),
          },
          partial: anyFailed,
          failedDomains: failedDomains.map((f) => ({
            domain: f.domain,
            phase: f.phase,
            // Keep error text short — the full detail for each failed
            // domain is in the worker log. The audit-log row is
            // user-facing.
            error: f.error.slice(0, 400),
          })),
        },
      },
    });

    // Flip the assessment out of ANALYSIS so the UI stops showing the
    // analysis-in-progress banner. Guarded on `status: "ANALYSIS"` so a
    // concurrent user action (e.g. manually advancing stage) isn't
    // clobbered — the `.catch` swallows both "row vanished" and
    // "status drifted" without noise, matching the pattern at the top
    // of this file.
    await db.assessment
      .update({
        where: { id: assessmentId, status: "ANALYSIS" },
        data: { status: POST_ANALYSIS_STAGE },
      })
      .catch(() => {
        /* row gone or status drifted — best-effort */
      });

    console.log(
      `[run-analysis] ✓ assessment=${assessmentId}${anyFailed ? " (partial)" : ""} (${Date.now() - started}ms)`,
    );
  } catch (err) {
    // Cancel is a clean exit, not a fault. Write a distinct terminal
    // row so the UI shows "Cancelled" instead of the scary red
    // FailureBanner. Don't rethrow — BullMQ treating this as a
    // successful job prevents auto-retry (which would defeat the
    // cancel).
    if (isCancelledError(err)) {
      console.log(
        `[run-analysis] ⊘ cancelled assessment=${assessmentId} (${Date.now() - started}ms)`,
      );
      await db.auditLog
        .create({
          data: {
            action: "RUN_ANALYSIS_CANCELLED",
            entityType: "Assessment",
            entityId: assessmentId,
            details: {
              durationMs: Date.now() - started,
            },
          },
        })
        .catch(() => {
          /* best-effort */
        });
      // Revert the stage so the UI clears the analysis banner. Same
      // target as success/failure — we don't have a dedicated
      // "cancelled" stage, and leaving the user in DRAFTING lets them
      // click Retry without first manually unsticking the status.
      await db.assessment
        .update({
          where: { id: assessmentId, status: "ANALYSIS" },
          data: { status: POST_ANALYSIS_STAGE },
        })
        .catch(() => {
          /* row gone or status drifted — best-effort */
        });
      return;
    }
    const classified = classifyProcessingError(err);
    console.error(
      `[run-analysis] ✗ assessment=${assessmentId} [${classified.category}]: ${classified.technicalDetail}`,
    );
    // Leave an audit trail the UI can query. We don't have a schema
    // column for "last analysis outcome" — AuditLog is where assessment-
    // level failure state lives (see `analysis.lastOutcome` tRPC).
    await db.auditLog
      .create({
        data: {
          action: "RUN_ANALYSIS_FAILED",
          entityType: "Assessment",
          entityId: assessmentId,
          details: {
            category: classified.category,
            label: classified.label,
            userMessage: classified.userMessage,
            nextStep: classified.nextStep,
            isRetryable: classified.isRetryable,
            needsAdmin: classified.needsAdmin,
            technicalDetail: classified.technicalDetail,
          },
        },
      })
      .catch(() => {
        /* best-effort */
      });
    // Flip out of ANALYSIS on hard failure too — the user needs to be
    // able to click Retry from a non-busy UI state. Same target as the
    // success path (DRAFTING, not a dedicated FAILED stage) because
    // the AssessmentStage enum has no FAILED member and we don't want
    // to introduce one without a schema change. The failure is
    // communicated via the `RUN_ANALYSIS_FAILED` audit row /
    // `lastFailure` tRPC — not the stage.
    await db.assessment
      .update({
        where: { id: assessmentId, status: "ANALYSIS" },
        data: { status: POST_ANALYSIS_STAGE },
      })
      .catch(() => {
        /* row gone or status drifted — best-effort */
      });
    throw err;
  }
}
