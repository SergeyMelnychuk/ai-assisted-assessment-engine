import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure } from "../trpc";
import {
  DEFAULT_REGISTRY,
  invalidateOverrides,
  type AiTask,
  type Provider,
} from "@/server/services/ai/model-registry";
import { probeAllProviders } from "@/server/services/ai/provider-status";

/**
 * Admin-only router for runtime `AiModelOverride` CRUD (ADR-0015 §7).
 *
 * Surface is deliberately minimal: list rows + the registry defaults so
 * the UI can show a "current effective binding" per task, upsert a
 * binding for a task, and delete an override (which reverts to default).
 *
 * Auth pattern matches `admin-settings.ts` — NOT_FOUND on non-admin so
 * the endpoint is invisible to role-probing.
 */

function assertAdmin(role: string): void {
  if (role !== "ADMIN") {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
}

const PROVIDERS = [
  "anthropic",
  "bedrock",
  "openai",
  "azure",
  "vertex",
  "mistral",
] as const satisfies readonly Provider[];

const AI_TASKS = [
  "analysis.synthesis",
  "analysis.verifier",
  "analysis.scoring",
  "deliverable.section",
  "diagram.generate",
  "diagram.parse",
  "estimation",
  "followups.generate",
  "agent.planner",
  "embedding.ingest",
  "embedding.query",
] as const satisfies readonly AiTask[];

const modelBindingSchema = z.object({
  provider: z.enum(PROVIDERS),
  model: z.string().min(1).max(200),
  maxTokens: z.number().int().positive().max(64_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  cacheSystem: z.boolean().optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
});

const upsertInput = z.object({
  task: z.enum(AI_TASKS),
  binding: modelBindingSchema,
  fallbacks: z.array(modelBindingSchema).max(5).default([]),
  reason: z.string().min(3).max(500),
  expiresAt: z.date().nullable().optional(),
});

export const adminAiRouterRouter = createRouter({
  /**
   * Returns the ADR-0015 defaults alongside any active override rows.
   * The UI merges these into a "task → effective binding" table.
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    assertAdmin(ctx.session.user.role);

    const overrides = await ctx.db.aiModelOverride.findMany({
      orderBy: { createdAt: "desc" },
    });

    const defaults = AI_TASKS.map((task) => ({
      task,
      binding: DEFAULT_REGISTRY[task],
    }));

    // Probe env-based credentials per provider so the UI can show
    // which dropdown options are actually callable today.
    const providerStatus = probeAllProviders(PROVIDERS);

    return {
      tasks: AI_TASKS,
      providers: PROVIDERS,
      providerStatus,
      defaults,
      overrides: overrides.map((o) => ({
        id: o.id,
        task: o.task,
        binding: o.binding,
        fallbacks: o.fallbacks,
        reason: o.reason,
        createdById: o.createdById,
        createdAt: o.createdAt,
        expiresAt: o.expiresAt,
      })),
    };
  }),

  upsert: protectedProcedure
    .input(upsertInput)
    .mutation(async ({ ctx, input }) => {
      assertAdmin(ctx.session.user.role);

      // Refuse to pin a task to a provider that has no credentials
      // wired — the call would fail at runtime with an opaque auth
      // error. Far better to reject the save with a clear message.
      const statuses = probeAllProviders(PROVIDERS);
      const targets = [input.binding, ...input.fallbacks];
      for (const b of targets) {
        const s = statuses.find((x) => x.provider === b.provider);
        if (s && !s.configured) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Provider "${b.provider}" has no credentials configured. ${s.note}`,
          });
        }
      }

      const row = await ctx.db.aiModelOverride.upsert({
        where: { task: input.task },
        create: {
          task: input.task,
          binding: input.binding,
          fallbacks: input.fallbacks,
          reason: input.reason,
          createdById: ctx.session.user.id,
          expiresAt: input.expiresAt ?? null,
        },
        update: {
          binding: input.binding,
          fallbacks: input.fallbacks,
          reason: input.reason,
          createdById: ctx.session.user.id,
          expiresAt: input.expiresAt ?? null,
        },
      });

      // Bust the in-process registry cache so the next callAi() sees
      // the new binding without a redeploy.
      invalidateOverrides();

      // Audit trail — overrides are operationally load-bearing; a stale
      // row stuck on a deprecated model id silently blocks calls.
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "AI_MODEL_OVERRIDE_UPSERT",
          entityType: "AiModelOverride",
          entityId: row.id,
          details: {
            task: input.task,
            binding: input.binding,
            fallbacks: input.fallbacks,
            reason: input.reason,
            expiresAt: input.expiresAt ?? null,
          },
        },
      });

      return { ok: true, id: row.id };
    }),

  delete: protectedProcedure
    .input(z.object({ task: z.enum(AI_TASKS) }))
    .mutation(async ({ ctx, input }) => {
      assertAdmin(ctx.session.user.role);

      const existing = await ctx.db.aiModelOverride.findUnique({
        where: { task: input.task },
      });
      if (!existing) {
        return { ok: true, deleted: false };
      }

      await ctx.db.aiModelOverride.delete({ where: { task: input.task } });
      invalidateOverrides();

      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "AI_MODEL_OVERRIDE_DELETE",
          entityType: "AiModelOverride",
          entityId: existing.id,
          details: { task: input.task },
        },
      });

      return { ok: true, deleted: true };
    }),
});
