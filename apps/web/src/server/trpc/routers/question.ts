import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure } from "../trpc";
import { assertAssessmentAccess } from "@/server/authz";
import {
  computeCoverage,
  seedBaselineQuestions,
} from "@/server/services/question-engine";
import { enqueueGenerateFollowUps } from "@/server/queue/queue";

export const questionRouter = createRouter({
  /**
   * List every question for an assessment with its most recent answer. The
   * UI does the grouping-by-domain client-side so we don't have to invent
   * a custom aggregate endpoint.
   */
  listByAssessment: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      return ctx.db.question.findMany({
        where: { assessmentId: input.assessmentId },
        orderBy: [{ domain: "asc" }, { priority: "asc" }, { orderIndex: "asc" }],
        include: {
          answers: {
            orderBy: { createdAt: "desc" },
            take: 1,
            include: {
              answeredBy: { select: { id: true, name: true, email: true } },
            },
          },
        },
      });
    }),

  /**
   * Seed the baseline question set from the knowledge base templates for
   * every active domain on the assessment. Idempotent — re-running after
   * the user adds a new active domain picks up only the new domain's
   * questions.
   */
  generateInitial: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      const res = await seedBaselineQuestions(ctx.db, input.assessmentId);
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "GENERATE_QUESTIONS",
          entityType: "Assessment",
          entityId: input.assessmentId,
          details: {
            created: res.created,
            skippedDomains: res.skippedDomains,
          },
        },
      });
      return res;
    }),

  /**
   * Coverage summary per-domain + overall. Used by the progress bars at
   * the top of the questions page.
   */
  getCoverage: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      return computeCoverage(ctx.db, input.assessmentId);
    }),

  /**
   * Persist an answer. Validates that the answer shape matches the
   * question's `questionType` before writing. Each call enqueues a
   * follow-up generation job (debounced BullMQ key) so the UI picks up
   * new AI questions once the worker runs.
   */
  answer: protectedProcedure
    .input(
      z.object({
        questionId: z.string().cuid(),
        answerText: z.string().max(8000).optional(),
        // answerData can carry arbitrary structured answers — single_choice
        // picks, multi_choice arrays, numeric values, etc. The shape is
        // validated below against the question type.
        answerData: z.any().optional(),
        confidenceNote: z.string().max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Resolve the question first (so we know its assessment), then gate
      // on assessment-scoped membership. Two round-trips but keeps the
      // NOT_FOUND semantics consistent with the rest of the app.
      const question = await ctx.db.question.findUnique({
        where: { id: input.questionId },
        select: {
          id: true,
          assessmentId: true,
          questionType: true,
          options: true,
        },
      });
      if (!question) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Question not found" });
      }
      await assertAssessmentAccess(
        ctx.db,
        ctx.session,
        question.assessmentId,
      );

      validateAnswerShape(question.questionType, question.options, input);

      // One Answer row per submission — keeps history. `isAnswered` flips
      // to true only on the first one; re-answering updates the pointer
      // but doesn't flip it back.
      const answer = await ctx.db.answer.create({
        data: {
          questionId: question.id,
          answerText: input.answerText?.trim() || null,
          answerData: input.answerData ?? undefined,
          answeredById: ctx.session.user.id,
          confidenceNote: input.confidenceNote?.trim() || null,
        },
      });
      await ctx.db.question.update({
        where: { id: question.id },
        data: { isAnswered: true },
      });

      // Fire-and-forget — if Redis is down we still succeed on the
      // answer write (auditability matters more than follow-ups).
      try {
        await enqueueGenerateFollowUps(question.assessmentId);
      } catch {
        // best-effort
      }

      return answer;
    }),
});

/**
 * Per-question-type validation of the answer payload. Keeps the DB clean
 * of "I filled in answerText for a single-choice" rows.
 */
function validateAnswerShape(
  type: string,
  options: unknown,
  input: { answerText?: string; answerData?: unknown },
): void {
  switch (type) {
    case "FREE_TEXT":
      if (!input.answerText || !input.answerText.trim()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "answerText is required for FREE_TEXT",
        });
      }
      return;
    case "SINGLE_CHOICE": {
      const choice = typeof input.answerData === "string"
        ? input.answerData
        : input.answerText;
      if (!choice) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A choice value is required",
        });
      }
      const opts = Array.isArray(options) ? (options as string[]) : [];
      if (opts.length > 0 && !opts.includes(choice)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Choice must be one of: ${opts.join(", ")}`,
        });
      }
      return;
    }
    case "MULTI_CHOICE": {
      const picks = Array.isArray(input.answerData)
        ? (input.answerData as string[])
        : null;
      if (!picks || picks.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "At least one choice is required",
        });
      }
      const opts = Array.isArray(options) ? (options as string[]) : [];
      if (opts.length > 0) {
        for (const p of picks) {
          if (!opts.includes(p)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Invalid choice: ${p}`,
            });
          }
        }
      }
      return;
    }
    case "NUMERIC": {
      const v =
        typeof input.answerData === "number"
          ? input.answerData
          : Number(input.answerText);
      if (Number.isNaN(v)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Numeric answer required",
        });
      }
      return;
    }
    case "CONFIRMATION": {
      const b =
        typeof input.answerData === "boolean"
          ? input.answerData
          : input.answerText === "true";
      void b;
      return;
    }
    case "FILE_UPLOAD":
      // File-upload answers are attached separately via the document
      // upload endpoint. We accept a pointer in answerData.
      return;
    default:
      return;
  }
}
