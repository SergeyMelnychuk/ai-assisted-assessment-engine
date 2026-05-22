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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { DiagramEditor } from "./diagram-editor";
import { SectionReview } from "@/components/review/section-review";
import { ReviewDashboard } from "@/components/review/review-dashboard";
import { GuideMarkdown } from "@/components/admin/guide/guide-markdown";

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
export function DeliverablePreview({ deliverableId }: { deliverableId: string }) {
  const utils = trpc.useUtils();
  const { data: sessionData } = useSession();
  const userRole = (sessionData?.user as { role?: string } | undefined)?.role;
  const canApproveReject = userRole === "ADMIN" || userRole === "REVIEWER";

  const query = trpc.deliverable.getById.useQuery(
    { id: deliverableId },
    { refetchInterval: 5_000 },
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

      <ReviewDashboard deliverableId={deliverableId} />

      {sections.length === 0 ? (
        <p className="rounded-md border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
          No sections yet. Re-run generation if this persists.
        </p>
      ) : (
        sections.map((section) => {
          const isEditing = editingSectionId === section.id;
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

              {isEditing ? (
                <CardContent>
                  <SectionEditor
                    title={section.title}
                    body={body}
                    busy={editMutation.isPending}
                    onCancel={() => setEditingSectionId(null)}
                    onSave={(next) =>
                      editMutation.mutate(
                        {
                          sectionId: section.id,
                          action: "EDIT",
                          newContent: next.body,
                          newTitle:
                            next.title !== section.title
                              ? next.title
                              : undefined,
                          comments: next.comment || undefined,
                        },
                        {
                          onSuccess: () => setEditingSectionId(null),
                        },
                      )
                    }
                  />
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
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditingSectionId(section.id)}
                    >
                      Edit
                    </Button>
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
    </div>
  );
}

function SectionEditor({
  title,
  body,
  busy,
  onCancel,
  onSave,
}: {
  title: string;
  body: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (next: { title: string; body: string; comment?: string }) => void;
}) {
  const [t, setT] = useState(title);
  const [b, setB] = useState(body);
  const [comment, setComment] = useState("");

  return (
    <div className="space-y-3">
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
          Content (markdown)
        </label>
        <Textarea
          className="mt-1 min-h-[240px] font-mono text-sm"
          value={b}
          onChange={(e) => setB(e.target.value)}
          disabled={busy}
        />
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
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy || !t.trim() || !b.trim()}
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
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
