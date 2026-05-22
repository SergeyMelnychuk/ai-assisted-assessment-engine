import { TRPCError } from "@trpc/server";
import type { PrismaClient, UserRole } from "@prisma/client";

/**
 * Shared authorization helpers for engagement/assessment-scoped resources.
 *
 * Design note: we uniformly throw `NOT_FOUND` (not `FORBIDDEN`) when a user
 * can't access a resource. That way the error code can't be used as an
 * existence oracle to enumerate engagements/assessments the caller shouldn't
 * know about.
 */

interface AuthSession {
  user: { id: string; role: UserRole };
}

/**
 * Prisma `where` fragment that restricts engagements to those the caller is
 * a member of. ADMIN short-circuits to `{}` for platform-wide visibility —
 * swap for a policy-based check once RBAC lands.
 */
export function engagementAccessFilter(session: AuthSession) {
  if (session.user.role === "ADMIN") return {};
  return { members: { some: { userId: session.user.id } } };
}

/**
 * Confirm the caller can touch the engagement. Throws `NOT_FOUND` otherwise.
 * Uses `count` so we don't pull a full row just to gate authorization.
 */
export async function assertEngagementAccess(
  db: PrismaClient,
  session: AuthSession,
  engagementId: string,
): Promise<void> {
  const visible = await db.engagement.count({
    where: { id: engagementId, ...engagementAccessFilter(session) },
  });
  if (visible === 0) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Engagement not found",
    });
  }
}

/**
 * Confirm the caller can touch the assessment (checked via parent engagement
 * membership). Returns the parent engagement id so callers needing it for
 * audit logs / redirects don't have to query again.
 *
 * Archived assessments are treated as invisible by default — every
 * read and every non-lifecycle mutation returns NOT_FOUND until the
 * row is restored. The `includeArchived` flag is the opt-in used by
 * the restore/delete mutations, which *must* load an archived row to
 * act on it. We deliberately do not expose this to leaf routers so
 * no query path accidentally serves archived data.
 */
export async function assertAssessmentAccess(
  db: PrismaClient,
  session: AuthSession,
  assessmentId: string,
  options: { includeArchived?: boolean } = {},
): Promise<{ engagementId: string }> {
  const assessment = await db.assessment.findFirst({
    where: {
      id: assessmentId,
      ...(options.includeArchived ? {} : { archivedAt: null }),
      engagement: engagementAccessFilter(session),
    },
    select: { engagementId: true },
  });
  if (!assessment) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Assessment not found",
    });
  }
  return { engagementId: assessment.engagementId };
}

/**
 * Gate for destructive write actions on analysis outputs (findings,
 * risks, recommendations, domain scores). Matches the product rule
 * "engagement OWNER or global ADMIN can delete; everyone else is
 * read-only on those tables".
 *
 * Throws `NOT_FOUND` if the assessment doesn't exist or the caller
 * can't see it at all (same opacity as `assertAssessmentAccess` —
 * don't leak existence). Throws `FORBIDDEN` if the caller has read
 * access (contributor/reviewer/viewer) but lacks the OWNER/ADMIN
 * privilege required for the mutation — that distinction matters
 * because the UI can show a tooltip explaining *why* a delete button
 * is disabled, rather than claiming the row vanished.
 *
 * Returns the parent engagement id so the caller can write an audit
 * log row without an extra query.
 */
export async function assertCanMutateAnalysisOutput(
  db: PrismaClient,
  session: AuthSession,
  assessmentId: string,
): Promise<{ engagementId: string }> {
  const { engagementId } = await assertAssessmentAccess(
    db,
    session,
    assessmentId,
  );
  if (session.user.role === "ADMIN") return { engagementId };
  const ownerMembership = await db.engagementMember.findFirst({
    where: {
      engagementId,
      userId: session.user.id,
      role: "OWNER",
    },
    select: { id: true },
  });
  if (!ownerMembership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only the engagement owner or an admin can delete this item",
    });
  }
  return { engagementId };
}

/**
 * Gate for mutations on the Engagement record itself (rename, industry
 * tweak, status lifecycle transitions). Same "OWNER or ADMIN" rule as
 * analysis outputs, but scoped to engagements directly — status moves
 * are a lifecycle concern the owner owns, not every contributor.
 *
 * Throws `NOT_FOUND` if the engagement is invisible (don't leak
 * existence); throws `FORBIDDEN` if the caller can see it but isn't
 * OWNER/ADMIN so the UI can explain the disabled control.
 */
export async function assertCanMutateEngagement(
  db: PrismaClient,
  session: AuthSession,
  engagementId: string,
): Promise<void> {
  await assertEngagementAccess(db, session, engagementId);
  if (session.user.role === "ADMIN") return;
  const ownerMembership = await db.engagementMember.findFirst({
    where: {
      engagementId,
      userId: session.user.id,
      role: "OWNER",
    },
    select: { id: true },
  });
  if (!ownerMembership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only the engagement owner or an admin can edit this engagement",
    });
  }
}

/**
 * Gate for destructive lifecycle actions on an Assessment record itself
 * (archive, restore, hard delete). Same "OWNER or ADMIN" rule as
 * {@link assertCanMutateEngagement}, but scoped through the assessment →
 * engagement join so callers can pass the assessment id directly.
 *
 * Returns the parent engagement id for audit-log attribution.
 */
export async function assertCanMutateAssessment(
  db: PrismaClient,
  session: AuthSession,
  assessmentId: string,
): Promise<{ engagementId: string }> {
  // The lifecycle mutations themselves (archive / restore / delete) need
  // to act on archived rows, so this gate opts in to seeing them. The
  // per-action rules (e.g. "can't archive an already-archived row") are
  // enforced by each mutation after this check.
  const { engagementId } = await assertAssessmentAccess(
    db,
    session,
    assessmentId,
    { includeArchived: true },
  );
  if (session.user.role === "ADMIN") return { engagementId };
  const ownerMembership = await db.engagementMember.findFirst({
    where: {
      engagementId,
      userId: session.user.id,
      role: "OWNER",
    },
    select: { id: true },
  });
  if (!ownerMembership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only the engagement owner or an admin can archive or delete this assessment",
    });
  }
  return { engagementId };
}

/**
 * Non-throwing counterpart to {@link assertCanMutateEngagement}. Used by
 * the UI to decide whether to render the status dropdown as an editable
 * control vs the read-only badge.
 */
export async function canMutateEngagement(
  db: PrismaClient,
  session: AuthSession,
  engagementId: string,
): Promise<boolean> {
  if (session.user.role === "ADMIN") {
    const visible = await db.engagement.count({ where: { id: engagementId } });
    return visible > 0;
  }
  const ownerMembership = await db.engagementMember.findFirst({
    where: {
      engagementId,
      userId: session.user.id,
      role: "OWNER",
    },
    select: { id: true },
  });
  return ownerMembership !== null;
}

/**
 * Non-throwing counterpart to {@link assertCanMutateAnalysisOutput}.
 * Returns `true` if the caller can delete analysis-output rows on this
 * assessment, `false` otherwise. Used by the UI to toggle trash-icon
 * visibility on findings / risks / recommendations / scoring lists.
 */
export async function canMutateAnalysisOutput(
  db: PrismaClient,
  session: AuthSession,
  assessmentId: string,
): Promise<boolean> {
  if (session.user.role === "ADMIN") {
    // ADMIN still needs to see the assessment exists; cheap membership-
    // bypassing count keeps the result honest without leaking.
    const visible = await db.assessment.count({ where: { id: assessmentId } });
    return visible > 0;
  }
  const ownerMembership = await db.engagementMember.findFirst({
    where: {
      userId: session.user.id,
      role: "OWNER",
      engagement: { assessments: { some: { id: assessmentId } } },
    },
    select: { id: true },
  });
  return ownerMembership !== null;
}
