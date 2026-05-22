"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ReviewBadge } from "@/components/analysis/review-badges";

interface SectionReviewProps {
  sectionId: string;
  sectionTitle: string;
  currentStatus: string;
  /** If false, the Approve/Reject buttons are hidden (caller role check). */
  canApproveReject: boolean;
  /** Called after any successful action so the parent can invalidate. */
  onChanged?: () => void;
}

type Mode = "idle" | "comment" | "history";

/**
 * Review action strip + expandable review history for one section.
 *
 * - Approve / Reject / Request revision: one-click primary actions,
 *   optional comment via the "Add comment" toggle.
 * - Edit-as-review lives in the parent preview (the section-level
 *   markdown editor already handles it there). The "EDIT" review action
 *   is still recorded server-side when the parent passes an explicit
 *   editing review, but the button UI stays simple here.
 * - History expands a panel that pulls `review.historyBySection` lazily
 *   (only when the user opens it).
 */
export function SectionReview({
  sectionId,
  sectionTitle,
  currentStatus,
  canApproveReject,
  onChanged,
}: SectionReviewProps) {
  const utils = trpc.useUtils();
  const [mode, setMode] = useState<Mode>("idle");
  const [comment, setComment] = useState("");
  const [pendingAction, setPendingAction] = useState<
    "APPROVE" | "REJECT" | "REQUEST_REVISION" | null
  >(null);

  const mutation = trpc.review.perform.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.deliverable.getById.invalidate(),
        utils.review.historyBySection.invalidate({ sectionId }),
        utils.review.deliverableProgress.invalidate(),
      ]);
      setMode("idle");
      setComment("");
      setPendingAction(null);
      onChanged?.();
    },
  });

  const historyQuery = trpc.review.historyBySection.useQuery(
    { sectionId },
    { enabled: mode === "history" },
  );

  function fire(action: "APPROVE" | "REJECT" | "REQUEST_REVISION") {
    mutation.mutate({ sectionId, action, comments: comment.trim() || undefined });
  }

  const busy = mutation.isPending;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ReviewBadge status={currentStatus} />
        <span className="text-xs text-muted-foreground">
          {labelFor(currentStatus)}
        </span>
        <div className="ml-auto flex flex-wrap gap-1">
          {canApproveReject ? (
            <>
              <Button
                size="sm"
                variant="default"
                disabled={busy || currentStatus === "APPROVED"}
                onClick={() => {
                  setPendingAction("APPROVE");
                  setMode("comment");
                }}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy || currentStatus === "REJECTED"}
                onClick={() => {
                  setPendingAction("REJECT");
                  setMode("comment");
                }}
              >
                Reject
              </Button>
            </>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || currentStatus === "NEEDS_REVISION"}
            onClick={() => {
              setPendingAction("REQUEST_REVISION");
              setMode("comment");
            }}
          >
            Request revision
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setMode(mode === "history" ? "idle" : "history")}
          >
            {mode === "history" ? "Hide history" : "History"}
          </Button>
        </div>
      </div>

      {mode === "comment" && pendingAction ? (
        <div className="rounded-md border bg-muted/20 p-3">
          <p className="text-xs text-muted-foreground">
            Comment on{" "}
            <strong>{sectionTitle}</strong> ({actionLabel(pendingAction)}) —
            optional, but helpful for the audit trail.
          </p>
          <Textarea
            className="mt-2 min-h-[72px] text-sm"
            placeholder="Why? Edge cases to double-check? Evidence links?"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            disabled={busy}
          />
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => fire(pendingAction)}
            >
              {busy
                ? "Saving…"
                : `Confirm ${actionLabel(pendingAction).toLowerCase()}`}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setMode("idle");
                setPendingAction(null);
                setComment("");
              }}
            >
              Cancel
            </Button>
            {mutation.error ? (
              <span className="text-xs text-destructive">
                {mutation.error.message}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {mode === "history" ? (
        <div className="rounded-md border bg-muted/10 p-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Review history
          </h4>
          {historyQuery.isLoading ? (
            <p className="mt-2 text-xs text-muted-foreground">Loading…</p>
          ) : historyQuery.error ? (
            <p className="mt-2 text-xs text-destructive">
              {historyQuery.error.message}
            </p>
          ) : historyQuery.data && historyQuery.data.length > 0 ? (
            <ul className="mt-2 space-y-2">
              {historyQuery.data.map((r) => (
                <li
                  key={r.id}
                  className="rounded-md border bg-background p-2 text-xs"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {actionLabel(r.action)}
                    </span>
                    <span className="text-muted-foreground">
                      {r.reviewer?.name ?? r.reviewer?.email ?? "?"}
                    </span>
                    <span className="text-muted-foreground">
                      {new Date(r.createdAt).toLocaleString(undefined, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </span>
                  </div>
                  {r.comments ? (
                    <p className="mt-1 whitespace-pre-wrap">{r.comments}</p>
                  ) : null}
                  {r.action === "EDIT" && r.contentBefore !== null ? (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-muted-foreground">
                        Content diff
                      </summary>
                      <div className="mt-2 grid gap-2 md:grid-cols-2">
                        <div>
                          <div className="text-[10px] uppercase text-muted-foreground">
                            Before
                          </div>
                          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border bg-muted/40 p-2">
                            {r.contentBefore ?? ""}
                          </pre>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase text-muted-foreground">
                            After
                          </div>
                          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border bg-muted/40 p-2">
                            {r.contentAfter ?? ""}
                          </pre>
                        </div>
                      </div>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              No review actions recorded yet.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function actionLabel(a: string): string {
  switch (a) {
    case "APPROVE":
      return "Approved";
    case "REJECT":
      return "Rejected";
    case "REQUEST_REVISION":
      return "Revision requested";
    case "EDIT":
      return "Edited";
    default:
      return a;
  }
}

function labelFor(status: string): string {
  switch (status) {
    case "DRAFT":
      return "AI draft — awaiting a reviewer";
    case "IN_REVIEW":
      return "Reviewer touching it";
    case "APPROVED":
      return "Approved — safe to export";
    case "REJECTED":
      return "Rejected — needs a rewrite";
    case "NEEDS_REVISION":
      return "Revision requested";
    default:
      return "";
  }
}
