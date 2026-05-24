"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { DiagramEditor } from "./diagram-editor";
import { SectionReview } from "@/components/review/section-review";
import { ReviewDashboard } from "@/components/review/review-dashboard";
import { GuideMarkdown } from "@/components/admin/guide/guide-markdown";
import { MarkdownEditor } from "@/components/common/markdown-editor";
import { TemplateFillDownload } from "@/components/templates/template-fill-download";
import type { TemplateKind } from "@prisma/client";

interface SectionRow {
  id: string;
  sectionKey: string;
  title: string;
  orderIndex: number;
  contentDraft: string | null;
  contentFinal: string | null;
  evidenceIds: string[];
  reviewStatus: string;
  reviewedById: string | null;
  reviewedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface DiagramRow {
  id: string;
  title: string;
  diagramFormat: string;
  diagramType: string | null;
  sourceCode: string | null;
  description: string | null;
  direction: string;
}

/**
 * Full deliverable view: review dashboard banner at top, section cards
 * with inline editor + review controls, then generated diagrams.
 *
 * Content edits flow through `review.perform({ action: "EDIT" })` so
 * every change lands in the `Review` audit trail with a before/after
 * snapshot. Approve / reject / request-revision actions go through the
 * same router.
 */
/**
 * Thin wrapper that gatekeeps on `deliverableId`. The hook-bearing
 * implementation lives in `DeliverablePreviewInner`; this wrapper
 * exists so the inner component (and ALL the tRPC `useQuery` calls it
 * registers) doesn't mount until we have a real string id.
 *
 * Why a wrapper vs. an `enabled: !!deliverableId` on the hooks alone:
 * during regeneration React's batched state updates can leave the
 * parent's `selectedId` momentarily undefined, and we kept seeing the
 * underlying tRPC request fire with `{}` despite the `enabled` flag.
 * Splitting at the component boundary stops the hooks from registering
 * at all on those transient renders — guaranteed, no closure / re-
 * render edge cases — and so the loggerLink has nothing to log.
 *
 * `key={deliverableId}` on the inner component also resets all internal
 * state (the edit dialog, regen feedback buffer, etc.) cleanly when the
 * user switches between deliverables.
 */
export function DeliverablePreview({
  deliverableId,
}: {
  deliverableId: string;
}) {
  if (typeof deliverableId !== "string" || deliverableId.length === 0) {
    return null;
  }
  return (
    <DeliverablePreviewInner
      key={deliverableId}
      deliverableId={deliverableId}
    />
  );
}

function DeliverablePreviewInner({
  deliverableId,
}: {
  deliverableId: string;
}) {
  const utils = trpc.useUtils();
  const { data: sessionData } = useSession();
  const userRole = (sessionData?.user as { role?: string } | undefined)?.role;
  const canApproveReject = userRole === "ADMIN" || userRole === "REVIEWER";

  const query = trpc.deliverable.getById.useQuery(
    { id: deliverableId },
    {
      // Belt-and-suspenders against the same scenario the wrapper
      // catches — the wrapper guarantees we won't be called with an
      // empty id, but if a future refactor forgets the wrapper this
      // keeps the bug from regressing.
      enabled: deliverableId.length > 0,
      refetchInterval: 5_000,
    },
  );

  // Edits route through the review router — keeps the audit trail
  // complete (before/after diff, actor, timestamp).
  const editMutation = trpc.review.perform.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.deliverable.getById.invalidate({ id: deliverableId }),
        utils.review.deliverableProgress.invalidate({ deliverableId }),
      ]);
    },
  });

  const [editingSectionId, setEditingSectionId] = useState<string | null>(null);
  const [regenSectionId, setRegenSectionId] = useState<string | null>(null);
  const [regenFeedback, setRegenFeedback] = useState("");

  const regenSectionMutation = trpc.deliverable.regenerateSection.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.deliverable.getById.invalidate({ id: deliverableId }),
        utils.review.deliverableProgress.invalidate({ deliverableId }),
      ]);
      setRegenSectionId(null);
      setRegenFeedback("");
    },
  });

  if (query.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (query.error) {
    const isNotFound = query.error.data?.code === "NOT_FOUND";
    return (
      <Card className="border-destructive/40 bg-destructive/5">
        <CardHeader>
          <CardTitle className="text-destructive">
            {isNotFound ? "Deliverable not found" : "Couldn't load deliverable"}
          </CardTitle>
          <CardDescription className="text-destructive/80">
            {isNotFound
              ? "It may have been deleted, or you don't have access."
              : query.error.message}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const deliverable = query.data;
  if (!deliverable) return null;

  const sections = deliverable.sections as SectionRow[];
  const diagrams = deliverable.diagrams as DiagramRow[];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="text-base">
              {deliverable.deliverableType.replace(/_/g, " ").toLowerCase()}
            </CardTitle>
            <CardDescription>
              {sections.length} section{sections.length === 1 ? "" : "s"} ·{" "}
              {diagrams.length} diagram{diagrams.length === 1 ? "" : "s"} ·{" "}
              status:{" "}
              <span className="font-medium">
                {deliverable.status.toLowerCase()}
              </span>
              {deliverable.templateId ? (
                <>
                  {" "}
                  · template:{" "}
                  <span className="font-medium">{deliverable.templateId}</span>
                </>
              ) : null}
            </CardDescription>
          </div>
        </CardHeader>
      </Card>

      {/* Populated-file download for THIS deliverable, sitting right
          under the summary card so the user doesn't have to scroll to
          find it. The component hides itself when no fill exists yet
          (e.g. the deliverable was generated but the post-fill step
          had no APPROVED template to use). Per ADR-0018 the per-
          deliverable TemplateKind enum is a 1:1 mirror of
          DeliverableType, so this cast is safe. */}
      <TemplateFillDownload
        assessmentId={deliverable.assessmentId}
        kind={deliverable.deliverableType as TemplateKind}
      />

      <ReviewDashboard deliverableId={deliverableId} />

      {sections.length === 0 ? (
        <p className="rounded-md border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
          No sections yet. Re-run generation if this persists.
        </p>
      ) : (
        sections.map((section) => {
          const isRegenOpen = regenSectionId === section.id;
          const isThisSectionRegenerating =
            regenSectionMutation.isPending && regenSectionId === section.id;
          const body = section.contentFinal ?? section.contentDraft ?? "";
          return (
            <Card key={section.id}>
              <CardHeader className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  {section.contentFinal ? (
                    <span className="inline-flex items-center rounded-full border border-green-500/40 bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-300">
                      published
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full border border-input bg-background px-2 py-0.5 text-xs text-muted-foreground">
                      AI draft
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    #{section.orderIndex + 1} · {section.sectionKey}
                  </span>
                </div>
                <CardTitle className="text-base leading-snug">
                  {section.title}
                </CardTitle>
              </CardHeader>

              {isRegenOpen ? (
                <CardContent className="space-y-3">
                  <div>
                    <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Reviewer feedback (optional)
                    </label>
                    <Textarea
                      className="mt-1 min-h-[96px]"
                      placeholder='e.g. "Cut the intro paragraph", "Rewrite for an executive audience", "Add more detail on the cost trade-offs".'
                      value={regenFeedback}
                      onChange={(e) => setRegenFeedback(e.target.value)}
                      disabled={isThisSectionRegenerating}
                    />
                  </div>
                  {section.contentFinal ? (
                    <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                      This section is already published. Regenerating will
                      replace it with a new draft and require a fresh
                      review before it can be re-approved.
                    </p>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={isThisSectionRegenerating}
                      onClick={() =>
                        regenSectionMutation.mutate({
                          sectionId: section.id,
                          feedback: regenFeedback.trim() || undefined,
                        })
                      }
                    >
                      {isThisSectionRegenerating
                        ? "Regenerating…"
                        : "Regenerate"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={isThisSectionRegenerating}
                      onClick={() => {
                        setRegenSectionId(null);
                        setRegenFeedback("");
                      }}
                    >
                      Cancel
                    </Button>
                    {regenSectionMutation.error &&
                    regenSectionId === section.id ? (
                      <span className="text-xs text-destructive">
                        {regenSectionMutation.error.message}
                      </span>
                    ) : null}
                  </div>
                </CardContent>
              ) : (
                <CardContent className="space-y-3">
                  <div className="rounded-md border bg-background p-4">
                    {body.trim().length > 0 ? (
                      // Render the markdown the model produced. Same
                      // GuideMarkdown component used for the admin
                      // operator guide — headings, lists, tables, and
                      // bold/italic come out properly formatted
                      // instead of as raw `## title` source.
                      <div className="deliverable-section-body">
                        <GuideMarkdown body={body} />
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        (empty — click Edit to add content)
                      </p>
                    )}
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditingSectionId(section.id)}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setRegenSectionId(section.id);
                          setRegenFeedback("");
                        }}
                      >
                        Regenerate…
                      </Button>
                    </div>
                  </div>
                  <SectionReview
                    sectionId={section.id}
                    sectionTitle={section.title}
                    currentStatus={section.reviewStatus}
                    canApproveReject={canApproveReject}
                  />
                </CardContent>
              )}
            </Card>
          );
        })
      )}

      {diagrams.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Generated diagrams
          </h2>
          {diagrams.map((d) => (
            <DiagramEditor key={d.id} diagram={d} />
          ))}
        </section>
      ) : null}

      {/* Section edit dialog — mounted once at the bottom and driven by
          `editingSectionId`. Replaces the previous inline edit that
          pushed the textarea below the fold and lost focus on open. The
          dialog focuses the content textarea by default so the user can
          start typing immediately. */}
      <SectionEditDialog
        section={
          editingSectionId
            ? sections.find((s) => s.id === editingSectionId) ?? null
            : null
        }
        busy={editMutation.isPending}
        onClose={() => setEditingSectionId(null)}
        onSave={(sectionId, next, originalTitle) =>
          editMutation.mutate(
            {
              sectionId,
              action: "EDIT",
              newContent: next.body,
              newTitle:
                next.title !== originalTitle ? next.title : undefined,
              comments: next.comment || undefined,
            },
            {
              onSuccess: () => setEditingSectionId(null),
            },
          )
        }
      />
    </div>
  );
}

/**
 * Full-screen section editor in a wide modal (5xl / 95vw, capped at
 * 90vh). Replaces the previous inline edit that scrolled the textarea
 * out of view and stole focus on open. Auto-focuses the content
 * textarea so the user can start typing immediately — that's the
 * primary editable surface, the Title is rarely changed.
 *
 * Local form state is keyed off `section.id`: changing which section
 * is being edited rebuilds the component, so stale buffers from a
 * previous section never leak into a new edit.
 */
function SectionEditDialog({
  section,
  busy,
  onClose,
  onSave,
}: {
  section: SectionRow | null;
  busy: boolean;
  onClose: () => void;
  onSave: (
    sectionId: string,
    next: { title: string; body: string; comment?: string },
    originalTitle: string,
  ) => void;
}) {
  return (
    <Dialog
      open={!!section}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      {section ? (
        // `key={section.id}` ensures the inner form remounts (and resets
        // its local buffers) when the user switches from one section's
        // edit to another's.
        <SectionEditDialogContent
          key={section.id}
          section={section}
          busy={busy}
          onCancel={onClose}
          onSave={(next) => onSave(section.id, next, section.title)}
        />
      ) : null}
    </Dialog>
  );
}

function SectionEditDialogContent({
  section,
  busy,
  onCancel,
  onSave,
}: {
  section: SectionRow;
  busy: boolean;
  onCancel: () => void;
  onSave: (next: { title: string; body: string; comment?: string }) => void;
}) {
  const initialBody = section.contentFinal ?? section.contentDraft ?? "";
  const [t, setT] = useState(section.title);
  const [b, setB] = useState(initialBody);
  const [comment, setComment] = useState("");

  const canSave = !busy && t.trim().length > 0 && b.trim().length > 0;

  return (
    <DialogContent
      size="wide"
      // Let Radix focus its default first focusable element. The
      // markdown editor below mounts a Tiptap rich-text view by
      // default; once it's interactive the reviewer can click into it
      // to start typing. (Previously we force-focused a single
      // textarea ref; that doesn't apply now that the editor has two
      // tab-switchable views.)
    >
      <DialogHeader>
        <DialogTitle>Edit section</DialogTitle>
        <DialogDescription>
          #{section.orderIndex + 1} · {section.sectionKey} ·{" "}
          {section.contentFinal ? "published — saving creates a new revision" : "AI draft"}
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="space-y-4">
        <div>
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Title
          </label>
          <Input
            className="mt-1"
            value={t}
            onChange={(e) => setT(e.target.value)}
            disabled={busy}
          />
        </div>
        <div>
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Content
          </label>
          <div className="mt-1">
            <MarkdownEditor
              value={b}
              onChange={setB}
              disabled={busy}
              minHeight="55vh"
            />
          </div>
        </div>
        <div>
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Edit rationale (optional)
          </label>
          <Textarea
            className="mt-1 min-h-[60px] text-sm"
            placeholder="Why did this section need an edit? Shows up in the review history."
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            disabled={busy}
          />
        </div>
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={!canSave}
          onClick={() =>
            onSave({
              title: t.trim(),
              body: b,
              comment: comment.trim() || undefined,
            })
          }
        >
          {busy ? "Saving…" : "Save edit"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
