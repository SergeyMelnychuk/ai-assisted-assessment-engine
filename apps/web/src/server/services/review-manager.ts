import type { PrismaClient, ReviewAction, ReviewStatus } from "@prisma/client";
import { TRPCError } from "@trpc/server";

/**
 * Review-manager — the single entry point for reviewer-facing actions on
 * a DeliverableSection. All paths:
 *   1. Load the section (so we have its `contentBefore` to snapshot)
 *   2. Apply the right section-state transition
 *   3. Write a `Review` row capturing who/what/when (+ content diff for EDIT)
 *
 * Kept as a service rather than inlined in the tRPC router so the worker
 * could call it too (e.g. auto-approve trivial sections — deferred for now).
 */

interface PerformReviewInput {
  sectionId: string;
  reviewerId: string;
  action: ReviewAction;
  comments?: string;
  /** Only used for EDIT action — the new contentFinal. */
  newContent?: string;
  /** Only used for EDIT action — optional title edit. */
  newTitle?: string;
}

export interface PerformReviewResult {
  sectionId: string;
  reviewId: string;
  reviewStatus: ReviewStatus;
  contentFinal: string | null;
}

/**
 * Apply a single review action. Returns the updated section plus the
 * review row id for audit-trail linking.
 */
export async function performReview(
  db: PrismaClient,
  input: PerformReviewInput,
): Promise<PerformReviewResult> {
  const section = await db.deliverableSection.findUnique({
    where: { id: input.sectionId },
    select: {
      id: true,
      deliverableId: true,
      contentDraft: true,
      contentFinal: true,
      title: true,
      reviewStatus: true,
    },
  });
  if (!section) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Section not found",
    });
  }

  const contentBefore = section.contentFinal ?? section.contentDraft ?? "";

  // Decide the target section state + content based on action. Each arm
  // leaves `contentAfter` as the value we'll snapshot into the Review row.
  let nextStatus: ReviewStatus;
  let contentAfter: string | null = contentBefore;
  let updateContentFinal = false;
  let updateTitle = false;

  switch (input.action) {
    case "APPROVE":
      nextStatus = "APPROVED";
      break;
    case "REJECT":
      nextStatus = "REJECTED";
      break;
    case "REQUEST_REVISION":
      nextStatus = "NEEDS_REVISION";
      break;
    case "EDIT": {
      if (typeof input.newContent !== "string" || !input.newContent.trim()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "EDIT requires newContent",
        });
      }
      contentAfter = input.newContent;
      updateContentFinal = true;
      updateTitle = typeof input.newTitle === "string" && input.newTitle.trim().length > 0;
      // Editing re-enters review unless the reviewer is simultaneously
      // approving (handled via a chained second call from the UI).
      nextStatus = "IN_REVIEW";
      break;
    }
    default: {
      const _exhaustive: never = input.action;
      throw new Error(`Unknown review action: ${String(_exhaustive)}`);
    }
  }

  const [review, updatedSection] = await db.$transaction([
    db.review.create({
      data: {
        deliverableSectionId: section.id,
        reviewerId: input.reviewerId,
        action: input.action,
        comments: input.comments?.slice(0, 4_000) ?? null,
        // Only snapshot content on EDIT — the other actions don't change
        // the body, so storing a copy would just bloat the audit log.
        contentBefore: input.action === "EDIT" ? contentBefore : null,
        contentAfter: input.action === "EDIT" ? contentAfter : null,
      },
    }),
    db.deliverableSection.update({
      where: { id: section.id },
      data: {
        reviewStatus: nextStatus,
        reviewedById: input.reviewerId,
        reviewedAt: new Date(),
        ...(updateContentFinal && contentAfter !== null
          ? { contentFinal: contentAfter }
          : {}),
        ...(updateTitle && input.newTitle
          ? { title: input.newTitle.trim().slice(0, 500) }
          : {}),
      },
    }),
  ]);

  return {
    sectionId: updatedSection.id,
    reviewId: review.id,
    reviewStatus: updatedSection.reviewStatus,
    contentFinal: updatedSection.contentFinal,
  };
}

/**
 * Full review history for a section — used by the UI's expandable
 * history panel. Orders newest-first so the most recent action is the
 * first thing the reviewer sees.
 */
export async function getSectionReviewHistory(
  db: PrismaClient,
  sectionId: string,
) {
  return db.review.findMany({
    where: { deliverableSectionId: sectionId },
    orderBy: { createdAt: "desc" },
    include: {
      reviewer: { select: { id: true, name: true, email: true } },
    },
  });
}

export interface DeliverableReviewProgress {
  deliverableId: string;
  totalSections: number;
  byStatus: Record<ReviewStatus, number>;
  /** Sections that still block deliverable APPROVAL. */
  blockingSections: Array<{
    id: string;
    title: string;
    sectionKey: string;
    reviewStatus: ReviewStatus;
  }>;
  /** True iff every section is APPROVED. */
  canApprove: boolean;
}

/**
 * Aggregate review state for a deliverable. Powers the review-dashboard
 * UI and the export-gate check. Returns both the counts (for display)
 * and the specific blocking sections (so the dashboard can point at
 * exactly what's left).
 */
export async function getDeliverableReviewProgress(
  db: PrismaClient,
  deliverableId: string,
): Promise<DeliverableReviewProgress> {
  const sections = await db.deliverableSection.findMany({
    where: { deliverableId },
    select: {
      id: true,
      title: true,
      sectionKey: true,
      reviewStatus: true,
    },
  });

  const byStatus: Record<ReviewStatus, number> = {
    DRAFT: 0,
    IN_REVIEW: 0,
    APPROVED: 0,
    REJECTED: 0,
    NEEDS_REVISION: 0,
  };
  for (const s of sections) byStatus[s.reviewStatus] += 1;

  const blocking = sections.filter((s) => s.reviewStatus !== "APPROVED");

  return {
    deliverableId,
    totalSections: sections.length,
    byStatus,
    blockingSections: blocking,
    canApprove: sections.length > 0 && blocking.length === 0,
  };
}

/**
 * Flip a deliverable to APPROVED, gated on every section being approved.
 * Returns the updated deliverable on success; throws BAD_REQUEST with
 * the list of blocking sections otherwise. Uses the `getDeliverableReview
 * Progress` helper so the gate stays in sync with the dashboard's UI.
 */
export async function approveDeliverable(
  db: PrismaClient,
  deliverableId: string,
): Promise<{ id: string; status: string }> {
  const progress = await getDeliverableReviewProgress(db, deliverableId);
  if (!progress.canApprove) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        progress.totalSections === 0
          ? "Deliverable has no sections to approve"
          : `${progress.blockingSections.length} section(s) still need approval: ${progress.blockingSections.map((s) => s.title).join(", ")}`,
    });
  }
  const deliverable = await db.deliverable.update({
    where: { id: deliverableId },
    data: { status: "APPROVED" },
    select: { id: true, status: true },
  });
  return deliverable;
}
