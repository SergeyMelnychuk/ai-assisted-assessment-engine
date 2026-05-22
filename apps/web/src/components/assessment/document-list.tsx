"use client";

import { useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FailureBanner } from "@/components/common/failure-banner";
import { DiagramViewer } from "./diagram-viewer";

// Render the ingest-pipeline state (Week 1, ADR-0001) rather than the
// legacy `processingStatus`. The five states that can appear in the UI:
//   PENDING     — queued, worker hasn't picked it up.
//   EXTRACTING  — text extraction in flight.
//   CHUNKED     — chunked; about to be marked READY. Shown transiently.
//   READY       — Evidence rows landed. Terminal success state.
//   FAILED      — classified failure. Terminal; `<FailureBanner>` fires.
// EMBEDDED is in the enum for Week 3 but the Week 1 worker never writes it.
type IngestStatus =
  | "PENDING"
  | "EXTRACTING"
  | "CHUNKED"
  | "EMBEDDED"
  | "READY"
  | "FAILED";

function formatIngestLabel(status: IngestStatus, chunkCount?: number | null) {
  switch (status) {
    case "PENDING":
      return "Queued…";
    case "EXTRACTING":
      return "Extracting text…";
    case "CHUNKED":
      return chunkCount ? `Chunked (${chunkCount} chunks)` : "Chunked";
    case "EMBEDDED":
      return chunkCount ? `Embedded (${chunkCount})` : "Embedded";
    case "READY":
      return chunkCount ? `Ready · ${chunkCount} chunks` : "Ready";
    case "FAILED":
      return "Failed";
  }
}

function StatusBadge({
  status,
  chunkCount,
}: {
  status: IngestStatus;
  chunkCount?: number | null;
}) {
  // Active states drive the refetch interval — make them visually distinct
  // so users see *something* is happening without refreshing. Tone split
  // mirrors the ingest-pipeline phases.
  const tone =
    status === "READY"
      ? "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-300"
      : status === "FAILED"
        ? "border-destructive/40 bg-destructive/10 text-destructive"
        : status === "EXTRACTING" || status === "CHUNKED" || status === "EMBEDDED"
          ? "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300"
          : "border-border bg-muted text-muted-foreground";
  const active =
    status === "PENDING" ||
    status === "EXTRACTING" ||
    status === "CHUNKED" ||
    status === "EMBEDDED";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {active ? (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      ) : null}
      {formatIngestLabel(status, chunkCount)}
    </span>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// Exact shape of one row from `document.listByAssessment`. Driven by
// the router so refactors upstream (e.g. adding `_count`) propagate
// here automatically.
type ListDocument = RouterOutputs["document"]["listByAssessment"][number];

export function DocumentList({ assessmentId }: { assessmentId: string }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());

  const listQuery = trpc.document.listByAssessment.useQuery(
    { assessmentId },
    {
      // While any doc is mid-ingest, poll every 2s. Once all docs are
      // terminal (READY or FAILED), stop — saves server round-trips on
      // idle tabs.
      refetchInterval: (query) => {
        const docs = query.state.data;
        if (!docs) return 2_000;
        const stillWorking = docs.some(
          (d) =>
            d.ingestStatus !== "READY" && d.ingestStatus !== "FAILED",
        );
        return stillWorking ? 2_000 : false;
      },
    },
  );

  // Repo-managed documents render inside the "Linked repositories"
  // panel, not here. We fetch the link list so we can hide the backing
  // parent Document + its children from the top-level documents list.
  const linksQuery = trpc.repositoryLink.list.useQuery({ assessmentId });

  if (listQuery.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }

  if (listQuery.error) {
    return (
      <p
        role="alert"
        className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        {listQuery.error.message}
      </p>
    );
  }

  const allDocs = listQuery.data ?? [];
  const repoManagedParentIds = new Set(
    (linksQuery.data ?? [])
      .map((l) => l.parentDocumentId)
      .filter((id): id is string => typeof id === "string"),
  );
  // Drop anything owned by a RepositoryLink — the repo panel renders
  // those. A repo-owned doc is either the parent tarball itself or a
  // child whose `parentDocumentId` is a repo-managed parent.
  const docs = allDocs.filter(
    (d) =>
      !repoManagedParentIds.has(d.id) &&
      (d.parentDocumentId == null ||
        !repoManagedParentIds.has(d.parentDocumentId)),
  );
  if (docs.length === 0) {
    return (
      <p className="rounded-md border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
        No documents yet. Upload one above to kick off analysis.
      </p>
    );
  }

  // Group archive children under their parent. Parents are docs with
  // no `parentDocumentId`; children are the extracted files from ZIP
  // uploads (W5, ADR-0008). Repository tarballs and their children
  // have already been filtered out above — they render inside the
  // "Linked repositories" panel. A parent with ≥1 child renders as
  // an expandable folder; a parent with zero children renders exactly
  // as before. The backend list is already sorted `createdAt desc`,
  // which we preserve for parents.
  const childrenByParent = new Map<string, ListDocument[]>();
  const parents: ListDocument[] = [];
  for (const d of docs) {
    if (d.parentDocumentId) {
      const bucket = childrenByParent.get(d.parentDocumentId) ?? [];
      bucket.push(d);
      childrenByParent.set(d.parentDocumentId, bucket);
    } else {
      parents.push(d);
    }
  }
  // Child order: by filename so a repo's src/a.ts sits next to src/b.ts.
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.filename.localeCompare(b.filename));
  }

  const toggleFolder = (id: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-3">
      {parents.map((parent) => {
        const children = childrenByParent.get(parent.id) ?? [];
        if (children.length === 0) {
          return (
            <DocumentCard
              key={parent.id}
              doc={parent}
              assessmentId={assessmentId}
              expanded={expandedId === parent.id}
              onToggle={() =>
                setExpandedId(expandedId === parent.id ? null : parent.id)
              }
            />
          );
        }
        return (
          <DocumentFolder
            key={parent.id}
            parent={parent}
            children={children}
            assessmentId={assessmentId}
            open={openFolders.has(parent.id)}
            onToggleOpen={() => toggleFolder(parent.id)}
            expandedChildId={expandedId}
            onToggleChild={(id) =>
              setExpandedId(expandedId === id ? null : id)
            }
          />
        );
      })}
    </div>
  );
}

/**
 * Expandable "folder" that groups the children extracted from a ZIP
 * archive or a linked repository tarball under their parent Document.
 * The parent's own card is still openable for summary/delete actions;
 * the folder just keeps the document list from drowning in 300 rows
 * of `src/**` files at the top level.
 */
function DocumentFolder({
  parent,
  children,
  assessmentId,
  open,
  onToggleOpen,
  expandedChildId,
  onToggleChild,
}: {
  parent: ListDocument;
  children: ListDocument[];
  assessmentId: string;
  open: boolean;
  onToggleOpen: () => void;
  expandedChildId: string | null;
  onToggleChild: (id: string) => void;
}) {
  const readyCount = children.filter((c) => c.ingestStatus === "READY").length;
  const failedCount = children.filter((c) => c.ingestStatus === "FAILED").length;
  const inFlightCount = children.length - readyCount - failedCount;

  return (
    <div className="space-y-2">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <button
            type="button"
            onClick={onToggleOpen}
            className="flex min-w-0 flex-1 items-start gap-2 text-left"
            aria-expanded={open}
          >
            <span
              aria-hidden
              className={`mt-1 inline-block transition-transform ${
                open ? "rotate-90" : ""
              }`}
            >
              ▶
            </span>
            <div className="min-w-0 flex-1">
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                <span className="truncate">{parent.filename}</span>
                <StatusBadge
                  status={parent.ingestStatus as IngestStatus}
                  chunkCount={parent.chunkCount}
                />
                <span className="text-xs font-normal text-muted-foreground">
                  {parent.uploadType.replace(/_/g, " ").toLowerCase()}
                </span>
              </CardTitle>
              <CardDescription>
                {children.length} file{children.length === 1 ? "" : "s"}
                {" · "}
                {readyCount} ready
                {inFlightCount > 0 ? ` · ${inFlightCount} in flight` : ""}
                {failedCount > 0 ? ` · ${failedCount} failed` : ""}
              </CardDescription>
            </div>
          </button>
        </CardHeader>
      </Card>

      {open ? (
        <div className="space-y-2 border-l-2 border-muted pl-4">
          {children.map((child) => (
            <DocumentCard
              key={child.id}
              doc={child}
              assessmentId={assessmentId}
              expanded={expandedChildId === child.id}
              onToggle={() => onToggleChild(child.id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One row in the document list. Extracted into its own component so each
 * card can fire its own `document.lastFailure` query conditionally —
 * can't put a `useQuery` inside a `.map` callback.
 */
export function DocumentCard({
  doc,
  assessmentId,
  expanded,
  onToggle,
}: {
  doc: ListDocument;
  assessmentId: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const utils = trpc.useUtils();
  const primaryDiagram = doc.diagrams[0];

  // Two-step inline delete: first click flips `confirmingDelete` and
  // swaps the button row for a "Confirm / Cancel" strip rendered in the
  // same place. No modal — the UX request was to keep the confirmation
  // embedded in the page so the user's focus stays on the card.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const deleteMutation = trpc.document.delete.useMutation({
    onSuccess: async () => {
      setConfirmingDelete(false);
      await utils.document.listByAssessment.invalidate({ assessmentId });
    },
  });

  const reprocessMutation = trpc.document.reprocess.useMutation({
    onSuccess: async () => {
      await utils.document.listByAssessment.invalidate({ assessmentId });
      await utils.document.lastFailure.invalidate({ id: doc.id });
    },
  });

  // Only fetch the classified failure when we actually need to render it:
  // card is expanded AND the document is in FAILED state. Keeps audit-log
  // traffic proportional to what the user is actually looking at.
  const isFailed = doc.ingestStatus === "FAILED";
  const failureQuery = trpc.document.lastFailure.useQuery(
    { id: doc.id },
    {
      enabled: expanded && isFailed,
      // A FAILED document's failure payload doesn't churn while the user
      // stares at it — one fetch is plenty. React Query's default
      // staleness handles refetch on focus.
      refetchOnWindowFocus: false,
    },
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0 flex-1">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <span className="truncate">{doc.filename}</span>
            <StatusBadge
              status={doc.ingestStatus as IngestStatus}
              chunkCount={doc.chunkCount}
            />
            <span className="text-xs font-normal text-muted-foreground">
              {doc.uploadType.replace(/_/g, " ").toLowerCase()}
            </span>
          </CardTitle>
          <CardDescription>
            {formatSize(doc.fileSize)} · uploaded by{" "}
            {doc.uploadedBy?.name ?? doc.uploadedBy?.email ?? "?"} ·{" "}
            {new Date(doc.createdAt).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </CardDescription>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onToggle}>
            {expanded ? "Hide" : "Open"}
          </Button>
        </div>
      </CardHeader>

      {expanded ? (
        <CardContent className="space-y-4">
          {/* FAILED path — render the category-aware banner with an
              integrated Retry button. Supersedes the plain "Summary"
              block and the separate "Retry processing" button. */}
          {isFailed ? (
            failureQuery.isLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : failureQuery.data ? (
              <FailureBanner
                failure={failureQuery.data}
                title="Processing"
                onRetry={() => reprocessMutation.mutate({ id: doc.id })}
                retrying={reprocessMutation.isPending}
              />
            ) : (
              // Graceful fallback — shouldn't hit in practice because the
              // server returns a classified row even for pre-classifier
              // failures (see `document.lastFailure`).
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive whitespace-pre-wrap">
                {doc.extractedSummary ?? "Processing failed."}
              </p>
            )
          ) : doc.extractedSummary ? (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Summary
              </h4>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">
                {doc.extractedSummary}
              </p>
            </div>
          ) : doc.ingestStatus !== "READY" && doc.ingestStatus !== "FAILED" ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : null}

          {primaryDiagram ? (
            <DiagramViewer diagram={primaryDiagram} documentId={doc.id} />
          ) : null}

          <div className="flex flex-wrap items-center gap-2 pt-2">
            <a
              className={buttonVariants({ variant: "secondary", size: "sm" })}
              href={`/api/documents/${doc.id}/download?download=1`}
              target="_blank"
              rel="noreferrer"
            >
              Download original
            </a>
            {confirmingDelete ? (
              // Inline confirmation strip — replaces the native
              // `window.confirm` modal. The warning text is lightly
              // tinted so it reads as "destructive action pending"
              // without pulling the user's eye off the card.
              <div
                role="alert"
                className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-sm text-destructive"
              >
                <span>
                  Delete <span className="font-medium">{doc.filename}</span>?
                  This cannot be undone.
                </span>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={deleteMutation.isPending}
                  onClick={() => deleteMutation.mutate({ id: doc.id })}
                >
                  {deleteMutation.isPending ? "Deleting…" : "Confirm delete"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={deleteMutation.isPending}
                  onClick={() => setConfirmingDelete(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => setConfirmingDelete(true)}
              >
                Delete
              </Button>
            )}
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}
