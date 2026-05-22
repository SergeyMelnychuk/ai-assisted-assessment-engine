import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure } from "../trpc";
import {
  assertAssessmentAccess,
  canMutateAnalysisOutput,
} from "@/server/authz";
import { enqueueRunAnalysis } from "@/server/queue/queue";
import { ANALYSIS_MODES } from "@/server/services/analysis-mode";

/**
 * Analysis entry-point router — kicks off the background run and lets
 * the UI poll the assessment status. The per-entity routers
 * (finding/risk/recommendation/scoring) handle list+update of the
 * produced artifacts.
 */
export const analysisRouter = createRouter({
  /**
   * Enqueue an analysis run. Returns immediately with the job id; the
   * client polls `assessment.getById` (status + counts) until it stops
   * looking busy.
   */
  run: protectedProcedure
    .input(
      z.object({
        assessmentId: z.string().cuid(),
        // Week 9 (ADR-0013): FAST runs the generator only, THOROUGH
        // adds the per-domain verifier pass (roughly doubles Claude
        // spend per run). Defaulting to FAST keeps legacy callers —
        // and the Retry button on the failure banner — cheap unless
        // the user opts in.
        mode: z.enum(ANALYSIS_MODES).default("FAST"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);

      // Flip to ANALYSIS status up front so the UI reflects the pending
      // run even before the worker claims the job. The worker re-sets
      // it when it starts — the state is effectively idempotent.
      await ctx.db.assessment.update({
        where: { id: input.assessmentId },
        data: { status: "ANALYSIS" },
      });

      const jobId = await enqueueRunAnalysis(input.assessmentId, input.mode);

      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "ENQUEUE_ANALYSIS",
          entityType: "Assessment",
          entityId: input.assessmentId,
          // Stamp `mode` into the enqueue audit so the usage dashboard
          // can later bucket AI_CALL spend by A/B arm without re-
          // deriving it from the RUN_ANALYSIS row.
          details: { jobId, mode: input.mode },
        },
      });

      return { jobId, mode: input.mode };
    }),

  /**
   * Aggregate counts — cheaper than pulling three lists just to render
   * the summary banner on the analysis landing page.
   */
  summary: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      const [findings, risks, recs, scores, assumptions] = await Promise.all([
        ctx.db.finding.count({ where: { assessmentId: input.assessmentId } }),
        ctx.db.risk.count({ where: { assessmentId: input.assessmentId } }),
        ctx.db.recommendation.count({
          where: { assessmentId: input.assessmentId },
        }),
        ctx.db.domainScore.count({
          where: { assessmentId: input.assessmentId },
        }),
        ctx.db.assumption.count({
          where: { assessmentId: input.assessmentId },
        }),
      ]);
      return { findings, risks, recommendations: recs, domainScores: scores, assumptions };
    }),

  /**
   * "Did the last analysis run fail?" — returns the most recent
   * `*_FAILED` audit-log row for this assessment so the UI can show a
   * diagnostic banner instead of an empty list.
   *
   * Returns `null` if the most recent terminal event was a success,
   * or if no run has been triggered yet.
   */
  /**
   * Per-domain status from the most recent `RUN_ANALYSIS` audit row —
   * Phase 3 Week 2 (ADR-0002). The UI renders one badge per domain
   * (ok / failed / n/a) and shows a partial-failure banner if any
   * domain's status is `failed`.
   *
   * Returns `null` if no successful run has happened yet. The legacy
   * `lastFailure` query still covers the all-domains-failed case.
   */
  perDomainStatus: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      const recent = await ctx.db.auditLog.findFirst({
        where: {
          entityType: "Assessment",
          entityId: input.assessmentId,
          action: "RUN_ANALYSIS",
        },
        orderBy: { createdAt: "desc" },
      });
      if (!recent) return null;
      // Suppress the per-domain banner when a newer `ENQUEUE_ANALYSIS`
      // has landed — a fresh run is in flight (or about to start) and
      // the previous run's partial-failure grid is no longer
      // authoritative. Without this, a user clicks "Run analysis",
      // the worker takes 4-6 minutes, and the stale "11 domain(s)
      // failed" banner lingers the whole time, making it look as if
      // the retry did nothing. Mirrors the ENQUEUE-aware suppression
      // in `lastFailure` below.
      const newerEnqueue = await ctx.db.auditLog.findFirst({
        where: {
          entityType: "Assessment",
          entityId: input.assessmentId,
          action: { in: ["ENQUEUE_ANALYSIS", "RUN_ANALYSIS_CANCELLED"] },
          createdAt: { gt: recent.createdAt },
        },
        orderBy: { createdAt: "desc" },
      });
      if (newerEnqueue) return null;
      const d = (recent.details ?? {}) as {
        mode?: "FAST" | "THOROUGH";
        domains?: {
          analysis?: Record<string, "ok" | "failed">;
          scoring?: Record<string, "ok" | "failed">;
          verify?: Record<string, "ok" | "failed">;
        };
        partial?: boolean;
        failedDomains?: Array<{ domain: string; phase: string; error: string }>;
      };
      const analysis = d.domains?.analysis ?? {};
      const scoring = d.domains?.scoring ?? {};
      // `verify` is omitted by the writer in FAST runs. Treat an
      // undefined map as "no verifier leg" (vs an empty map of a
      // verifier run where every domain happened to fail) so the UI
      // can suppress the third badge on Draft runs entirely.
      const verify = d.domains?.verify;
      const hasVerifyLeg = verify !== undefined;
      const allDomains = Array.from(
        new Set([...Object.keys(analysis), ...Object.keys(scoring)]),
      ).sort();
      // Cross-reference surviving data per domain. When a user clears
      // findings/risks/recs or a domain score after a run, the audit
      // log still says "ok" — but the UI shouldn't keep showing
      // `Analysis:ok` / `Scoring:ok` for a domain with zero surviving
      // rows. Null-ing the leg flips the badge to `—` (handled by
      // `labelFor(null)` in the shell).
      const [findingRows, riskRows, recRows, scoreRows] = await Promise.all([
        ctx.db.finding.groupBy({
          by: ["domain"],
          where: { assessmentId: input.assessmentId },
          _count: { _all: true },
        }),
        // Risk stores the domain under `category` (historic — predates
        // the `domain` column on Finding/Recommendation). Group by that
        // and normalise into the same shape below.
        ctx.db.risk.groupBy({
          by: ["category"],
          where: { assessmentId: input.assessmentId },
          _count: { _all: true },
        }),
        ctx.db.recommendation.groupBy({
          by: ["domain"],
          where: { assessmentId: input.assessmentId },
          _count: { _all: true },
        }),
        ctx.db.domainScore.findMany({
          where: { assessmentId: input.assessmentId },
          select: { domain: true },
        }),
      ]);
      const analysisHas = new Set<string>();
      for (const r of findingRows) {
        if (r._count._all > 0) analysisHas.add(r.domain);
      }
      for (const r of recRows) {
        if (r._count._all > 0) analysisHas.add(r.domain);
      }
      for (const r of riskRows) {
        if (r._count._all > 0) analysisHas.add(r.category);
      }
      const scoringHas = new Set(scoreRows.map((r) => r.domain));
      return {
        completedAt: recent.createdAt,
        // Mode of the run that produced this grid. `null` on legacy
        // rows that predate the FAST/THOROUGH split (ADR-0013).
        mode: d.mode ?? null,
        partial: d.partial ?? false,
        // Tells the UI whether to render the Verify leg at all. We
        // deliberately use a separate flag rather than "any non-null
        // verify value" — a Reviewed run with every verifier leg null
        // (impossible today, but future-proof) should still show the
        // column as "—".
        hasVerifyLeg,
        domains: allDomains.map((domain) => {
          const analysisStatus = analysis[domain] ?? null;
          const scoringStatus = scoring[domain] ?? null;
          // If the audit said "ok" but every finding/risk/rec for this
          // domain has been cleared, demote the analysis leg to null.
          // "failed" audit rows are preserved verbatim — the run really
          // did fail, and clearing findings afterwards shouldn't erase
          // the diagnostic.
          const effectiveAnalysis =
            analysisStatus === "ok" && !analysisHas.has(domain)
              ? null
              : analysisStatus;
          const effectiveScoring =
            scoringStatus === "ok" && !scoringHas.has(domain)
              ? null
              : scoringStatus;
          // Verify leg is recorded against the generator output; if
          // the generator output is gone the verify signal is
          // meaningless too.
          const verifyStatus = hasVerifyLeg
            ? (verify?.[domain] ?? null)
            : null;
          const effectiveVerify =
            verifyStatus === "ok" && effectiveAnalysis === null
              ? null
              : verifyStatus;
          return {
            domain,
            analysis: effectiveAnalysis,
            scoring: effectiveScoring,
            verify: effectiveVerify,
          };
        }),
        failedDomains: d.failedDomains ?? [],
      };
    }),

  /**
   * Soft cancel for an in-flight analysis run. Writes a
   * `CANCEL_ANALYSIS_REQUESTED` audit row; the worker polls between
   * domains (see `services/cancellation.ts`) and exits cleanly when
   * it sees one newer than the run's start. Succeeded domains are
   * kept; un-started domains are skipped.
   *
   * OWNER/ADMIN-gated to match the other destructive surfaces
   * (delete, clearAll) — the user who cancels should also be someone
   * empowered to wipe outputs.
   */
  cancel: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      const allowed = await canMutateAnalysisOutput(
        ctx.db,
        ctx.session,
        input.assessmentId,
      );
      if (!allowed) {
        // Match the shape of assertCanMutateAnalysisOutput's throw so
        // the client gets the same FORBIDDEN message across surfaces.
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You don't have permission to cancel this run.",
        });
      }
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "CANCEL_ANALYSIS_REQUESTED",
          entityType: "Assessment",
          entityId: input.assessmentId,
          details: {},
        },
      });
      return { ok: true };
    }),

  /**
   * Is an analysis run currently in flight?  Returns `true` when the
   * most-recent analysis-lifecycle audit row is `ENQUEUE_ANALYSIS` (no
   * terminal row since), plus `cancelRequested` if the user has already
   * asked to cancel this run.
   *
   * Used by the UI to show/hide the Cancel button. The run-detection
   * is audit-log-based (not Redis queue inspection) so it survives
   * worker restarts and matches the way other analysis-surface queries
   * reason about lifecycle.
   */
  runStatus: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      // Pull the most-recent enqueue and the most-recent terminal row
      // separately rather than relying on "last row wins" — belt and
      // braces against any future ordering tie (two rows in the same
      // millisecond) or a job that wrote a terminal row with a slightly
      // older `createdAt` than the enqueue for any reason. `inFlight`
      // is true **only** when an ENQUEUE_ANALYSIS row exists AND no
      // terminal `RUN_ANALYSIS*` row has landed since.
      const lastEnqueue = await ctx.db.auditLog.findFirst({
        where: {
          entityType: "Assessment",
          entityId: input.assessmentId,
          action: "ENQUEUE_ANALYSIS",
        },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      if (!lastEnqueue) {
        return { inFlight: false, cancelRequested: false };
      }
      const terminalSince = await ctx.db.auditLog.findFirst({
        where: {
          entityType: "Assessment",
          entityId: input.assessmentId,
          action: {
            in: [
              "RUN_ANALYSIS",
              "RUN_ANALYSIS_FAILED",
              "RUN_ANALYSIS_CANCELLED",
            ],
          },
          createdAt: { gte: lastEnqueue.createdAt },
        },
        select: { id: true },
      });
      const inFlight = terminalSince === null;
      if (!inFlight) {
        return { inFlight: false, cancelRequested: false };
      }
      const recent = { createdAt: lastEnqueue.createdAt };
      // Check if we've already filed a cancel for this run.
      const cancel = await ctx.db.auditLog.findFirst({
        where: {
          entityType: "Assessment",
          entityId: input.assessmentId,
          action: "CANCEL_ANALYSIS_REQUESTED",
          createdAt: { gte: recent.createdAt },
        },
        select: { id: true },
      });
      return {
        inFlight: true,
        cancelRequested: cancel !== null,
        enqueuedAt: recent.createdAt,
      };
    }),

  /**
   * Hide the current failure banner. Writes a deliberately-newer
   * `ANALYSIS_FAILURE_DISMISSED` audit row so the same "latest-row
   * wins" lookup in `lastFailure` returns null on the next poll. The
   * row stays in the audit log so an operator can see who dismissed
   * what and when. Banner re-appears automatically when a new
   * `*_FAILED` row lands later.
   */
  dismissLastFailure: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "ANALYSIS_FAILURE_DISMISSED",
          entityType: "Assessment",
          entityId: input.assessmentId,
          details: {},
        },
      });
      return { ok: true };
    }),

  lastFailure: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      const recent = await ctx.db.auditLog.findFirst({
        where: {
          entityType: "Assessment",
          entityId: input.assessmentId,
          action: {
            in: [
              // Include `ENQUEUE_*` so a freshly-triggered run suppresses
              // the stale failure banner until the worker writes a new
              // terminal row. Otherwise the banner persists from the
              // previous failure and it looks as if "Run analysis" did
              // nothing.
              "ENQUEUE_ANALYSIS",
              "RUN_ANALYSIS",
              "RUN_ANALYSIS_FAILED",
              "RUN_ANALYSIS_CANCELLED",
              "ENQUEUE_ESTIMATION",
              "RUN_ESTIMATION",
              "RUN_ESTIMATION_FAILED",
              "ENQUEUE_DELIVERABLE",
              "GENERATE_DELIVERABLE",
              "GENERATE_DELIVERABLE_FAILED",
              // User-driven dismissal. Same shape as the run rows so
              // the same "latest row wins" logic clears the banner.
              "ANALYSIS_FAILURE_DISMISSED",
            ],
          },
        },
        orderBy: { createdAt: "desc" },
      });
      if (!recent || !recent.action.endsWith("_FAILED")) return null;
      // The job-handler writes { category, label, userMessage, nextStep,
      // isRetryable, needsAdmin, technicalDetail } into `details`. We
      // expose the user-facing fields only; `technicalDetail` stays
      // server-side (admins can query audit-log directly).
      const d = (recent.details ?? {}) as {
        category?: string;
        label?: string;
        userMessage?: string;
        nextStep?: string;
        isRetryable?: boolean;
        needsAdmin?: boolean;
      };
      return {
        action: recent.action,
        failedAt: recent.createdAt,
        category: d.category ?? "UNKNOWN",
        label: d.label ?? "Last run failed",
        userMessage:
          d.userMessage ?? "The last run didn't produce any results.",
        nextStep:
          d.nextStep ?? "Click Retry to try again.",
        isRetryable: d.isRetryable ?? true,
        needsAdmin: d.needsAdmin ?? false,
      };
    }),

  /**
   * Per-domain progress snapshot for the current in-flight run. Returns
   * an entry per active domain with one of four statuses:
   *
   *   - `pending`  — no "domain analysis start" log yet
   *   - `running`  — start logged, no complete/failed yet
   *   - `complete` — "domain analysis complete" landed (with durationMs)
   *   - `failed`   — "domain analysis failed" landed (with error)
   *
   * Data source is the `Log` table, not BullMQ internals, so this
   * survives worker restarts and shares the same substrate as the
   * /admin/logs viewer. The UI polls this while
   * `runStatus.inFlight === true` to give the user a live pulse
   * instead of the undifferentiated "running…" banner — the absence
   * of progress was probably the trigger for the cancel-and-retry
   * bursts we saw on 2026-04-19.
   *
   * Run window is bounded by the most-recent `ENQUEUE_ANALYSIS` audit
   * row (nothing older counts — we don't want logs from a previous
   * run leaking into the current snapshot). Returns `null` when no
   * run has ever been enqueued for this assessment.
   */
  runProgress: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);

      const [assessment, lastEnqueue] = await Promise.all([
        ctx.db.assessment.findUnique({
          where: { id: input.assessmentId },
          select: { activeDomains: true },
        }),
        ctx.db.auditLog.findFirst({
          where: {
            entityType: "Assessment",
            entityId: input.assessmentId,
            action: "ENQUEUE_ANALYSIS",
          },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        }),
      ]);
      if (!assessment || !lastEnqueue) return null;

      // Fetch all worker:analysis log rows in this run window. An
      // assessment has at most 8 active domains × {start, complete,
      // failed, verify, scoring} ≈ O(40) rows, so pulling them in one
      // query and bucketing in JS is cheaper than eight per-domain
      // findFirsts.
      const rows = await ctx.db.log.findMany({
        where: {
          assessmentId: input.assessmentId,
          source: "worker:analysis",
          createdAt: { gte: lastEnqueue.createdAt },
        },
        orderBy: { createdAt: "asc" },
        select: {
          createdAt: true,
          message: true,
          context: true,
          error: true,
        },
      });

      type DomainProgress = {
        domain: string;
        status: "pending" | "running" | "complete" | "failed";
        startedAt: Date | null;
        completedAt: Date | null;
        durationMs: number | null;
        error: string | null;
      };
      const byDomain = new Map<string, DomainProgress>();
      for (const d of assessment.activeDomains) {
        byDomain.set(d, {
          domain: d,
          status: "pending",
          startedAt: null,
          completedAt: null,
          durationMs: null,
          error: null,
        });
      }

      for (const row of rows) {
        const ctxObj = (row.context ?? {}) as {
          domain?: string;
          durationMs?: number;
        };
        const domain = ctxObj.domain;
        if (!domain) continue;
        const entry = byDomain.get(domain);
        if (!entry) continue; // Domain not in activeDomains — ignore.
        if (row.message === "domain analysis start") {
          entry.status = "running";
          entry.startedAt = row.createdAt;
        } else if (row.message === "domain analysis complete") {
          entry.status = "complete";
          entry.completedAt = row.createdAt;
          if (typeof ctxObj.durationMs === "number") {
            entry.durationMs = ctxObj.durationMs;
          } else if (entry.startedAt) {
            entry.durationMs =
              row.createdAt.getTime() - entry.startedAt.getTime();
          }
        } else if (row.message === "domain analysis failed") {
          entry.status = "failed";
          entry.completedAt = row.createdAt;
          entry.error = row.error ?? null;
        }
      }

      const domains = Array.from(byDomain.values());
      const total = domains.length;
      const completed = domains.filter((d) => d.status === "complete").length;
      const failed = domains.filter((d) => d.status === "failed").length;
      const running = domains.filter((d) => d.status === "running").length;
      return {
        enqueuedAt: lastEnqueue.createdAt,
        domains,
        total,
        completed,
        failed,
        running,
        pending: total - completed - failed - running,
      };
    }),

  /**
   * Whether the caller can delete analysis-output rows (findings /
   * risks / recommendations / scoring) on this assessment. The four
   * list components call this to decide whether to render their
   * per-row trash icons. Cheap — one `count` in the ADMIN path, one
   * `findFirst` for everyone else.
   */
  canMutateOutputs: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      // Access check first — a user who can't see the assessment must
      // get the same `NOT_FOUND` shape as everywhere else, not a
      // boolean `false` that would leak existence.
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      return canMutateAnalysisOutput(
        ctx.db,
        ctx.session,
        input.assessmentId,
      );
    }),
});
