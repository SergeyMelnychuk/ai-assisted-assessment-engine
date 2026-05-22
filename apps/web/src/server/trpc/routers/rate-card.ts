import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure } from "../trpc";

/**
 * Rate-card CRUD router. ADMIN-only. Estimate row snapshots
 * (`roleAllocations` on `Estimate`) are preserved when a card is edited —
 * edits never retroactively reprice historical estimates. Delete is
 * blocked when any Estimate still references the card.
 *
 * The `rates` JSON column is modeled as a free-form array of rows,
 * `{ role, seniority, hourlyRate, dailyRate? }`. `role` is a free-form
 * string so admins can register new roles by simply adding a row.
 *
 * `isDefault` is mutually exclusive across rows — the `setDefault` and
 * any create/update that sets `isDefault = true` unset every other
 * card's flag inside a single transaction.
 */

const SENIORITIES = ["JUNIOR", "MID", "SENIOR", "LEAD", "PRINCIPAL"] as const;

const rateRowSchema = z.object({
  role: z.string().trim().min(1).max(120),
  seniority: z.enum(SENIORITIES),
  hourlyRate: z.number().positive().max(10_000),
  dailyRate: z.number().positive().max(100_000).optional(),
});

const ratesSchema = z.array(rateRowSchema).max(500);

function assertAdmin(ctx: { session: { user: { role: string } } }) {
  if (ctx.session.user.role !== "ADMIN") {
    // Mirror the uniform NOT_FOUND convention used elsewhere so the
    // code can't be used to probe the admin surface.
    throw new TRPCError({ code: "NOT_FOUND" });
  }
}

export const rateCardRouter = createRouter({
  list: protectedProcedure.query(async ({ ctx }) => {
    assertAdmin(ctx);
    const cards = await ctx.db.rateCard.findMany({
      orderBy: [{ isDefault: "desc" }, { validFrom: "desc" }],
      include: { _count: { select: { estimates: true } } },
    });
    return cards;
  }),

  get: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      assertAdmin(ctx);
      const card = await ctx.db.rateCard.findUnique({
        where: { id: input.id },
        include: { _count: { select: { estimates: true } } },
      });
      if (!card) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Rate card not found" });
      }
      return card;
    }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(200),
        currency: z.string().trim().min(3).max(8).default("USD"),
        rates: ratesSchema,
        validFrom: z.date(),
        validTo: z.date().nullable().optional(),
        isDefault: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertAdmin(ctx);

      const created = await ctx.db.$transaction(async (tx) => {
        if (input.isDefault) {
          await tx.rateCard.updateMany({
            where: { isDefault: true },
            data: { isDefault: false },
          });
        }
        const row = await tx.rateCard.create({
          data: {
            name: input.name,
            currency: input.currency,
            rates: input.rates,
            validFrom: input.validFrom,
            validTo: input.validTo ?? null,
            isDefault: input.isDefault,
          },
        });
        await tx.auditLog.create({
          data: {
            userId: ctx.session.user.id,
            action: "CREATE_RATE_CARD",
            entityType: "RateCard",
            entityId: row.id,
            details: {
              name: row.name,
              currency: row.currency,
              rateCount: input.rates.length,
              isDefault: row.isDefault,
            },
          },
        });
        return row;
      });
      return created;
    }),

  /**
   * Partial update. Pass `rates` as a full replacement array — we don't
   * merge row-by-row because the JSON column has no stable row id to key
   * against. If a future caller needs per-row edits, build them on top
   * of this by reading, mutating, and resending the full array.
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        name: z.string().trim().min(1).max(200).optional(),
        currency: z.string().trim().min(3).max(8).optional(),
        rates: ratesSchema.optional(),
        validFrom: z.date().optional(),
        validTo: z.date().nullable().optional(),
        isDefault: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertAdmin(ctx);
      const { id, ...changes } = input;

      const existing = await ctx.db.rateCard.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Rate card not found" });
      }

      const updated = await ctx.db.$transaction(async (tx) => {
        if (changes.isDefault === true) {
          await tx.rateCard.updateMany({
            where: { isDefault: true, NOT: { id } },
            data: { isDefault: false },
          });
        }
        const data: Record<string, unknown> = {};
        if (changes.name !== undefined) data.name = changes.name;
        if (changes.currency !== undefined) data.currency = changes.currency;
        if (changes.rates !== undefined) data.rates = changes.rates;
        if (changes.validFrom !== undefined) data.validFrom = changes.validFrom;
        if (changes.validTo !== undefined) data.validTo = changes.validTo;
        if (changes.isDefault !== undefined) data.isDefault = changes.isDefault;

        const row = await tx.rateCard.update({ where: { id }, data });
        await tx.auditLog.create({
          data: {
            userId: ctx.session.user.id,
            action: "UPDATE_RATE_CARD",
            entityType: "RateCard",
            entityId: row.id,
            details: {
              changedKeys: Object.keys(data),
              rateCount: Array.isArray(row.rates)
                ? (row.rates as unknown[]).length
                : undefined,
              isDefault: row.isDefault,
            },
          },
        });
        return row;
      });
      return updated;
    }),

  setDefault: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      assertAdmin(ctx);
      const existing = await ctx.db.rateCard.findUnique({
        where: { id: input.id },
        select: { id: true, isDefault: true },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Rate card not found" });
      }
      if (existing.isDefault) return { id: input.id, isDefault: true };

      await ctx.db.$transaction(async (tx) => {
        await tx.rateCard.updateMany({
          where: { isDefault: true, NOT: { id: input.id } },
          data: { isDefault: false },
        });
        await tx.rateCard.update({
          where: { id: input.id },
          data: { isDefault: true },
        });
        await tx.auditLog.create({
          data: {
            userId: ctx.session.user.id,
            action: "UPDATE_RATE_CARD",
            entityType: "RateCard",
            entityId: input.id,
            details: { changedKeys: ["isDefault"], isDefault: true },
          },
        });
      });
      return { id: input.id, isDefault: true };
    }),

  /**
   * Delete is blocked if any Estimate still points at this card. The
   * schema's FK has no `onDelete` rule so the raw DB error would be a
   * P2003 — we pre-check so the UI can surface a friendly message.
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      assertAdmin(ctx);
      const existing = await ctx.db.rateCard.findUnique({
        where: { id: input.id },
        select: { id: true, name: true, isDefault: true },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Rate card not found" });
      }
      const referencing = await ctx.db.estimate.count({
        where: { rateCardId: input.id },
      });
      if (referencing > 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Can't delete — ${referencing} estimate${referencing === 1 ? "" : "s"} reference this rate card.`,
        });
      }

      await ctx.db.$transaction(async (tx) => {
        await tx.rateCard.delete({ where: { id: input.id } });
        await tx.auditLog.create({
          data: {
            userId: ctx.session.user.id,
            action: "DELETE_RATE_CARD",
            entityType: "RateCard",
            entityId: input.id,
            details: { name: existing.name, wasDefault: existing.isDefault },
          },
        });
      });
      return { success: true };
    }),
});
