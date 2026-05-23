"use client";

import { useState } from "react";
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
import { DocumentCard } from "./document-list";

/**
 * Repository-link UI (Phase 3 Week 6 gap-fill).
 *
 * Renders on the Documents tab:
 *   1. A "Link repository" button that opens a modal with fields for
 *      URL, PAT (password input), branch (default `main`), and an
 *      optional ref. Submit calls `trpc.repositoryLink.create`;
 *      validation errors surface inline.
 *   2. A card per linked repo with status badge, last-synced
 *      timestamp, URL, and a "Re-sync now" button wired to
 *      `trpc.repositoryLink.resync`.
 *
 * The `branch` and `ref` fields are captured client-side for user
 * reassurance; the MVP `repositoryLink.create` router doesn't
 * persist them yet (the tarball API defaults to the default branch).
 * Wiring the backend for arbitrary refs is a follow-up — leaving the
 * fields in now keeps the UX stable when that lands.
 */

type IngestStatus =
  | "PENDING"
  | "EXTRACTING"
  | "CHUNKED"
  | "READY"
  | "FAILED"
  | "SYNCING";

function statusTone(status: string): string {
  switch (status) {
    case "READY":
      return "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-300";
    case "FAILED":
      return "border-destructive/40 bg-destructive/10 text-destructive";
    case "PENDING":
    case "EXTRACTING":
    case "CHUNKED":
    case "SYNCING":
      return "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "PENDING":
      return "Queued";
    case "EXTRACTING":
      return "Fetching…";
    case "CHUNKED":
      return "Ingesting…";
    case "SYNCING":
      return "Syncing…";
    case "READY":
      return "Ready";
    case "FAILED":
      return "Failed";
    default:
      return status;
  }
}

export function RepositoryLinkPanel({
  assessmentId,
}: {
  assessmentId: string;
}) {
  const utils = trpc.useUtils();
  const [modalOpen, setModalOpen] = useState(false);
  const [openLinkIds, setOpenLinkIds] = useState<Set<string>>(new Set());
  const [expandedChildId, setExpandedChildId] = useState<string | null>(null);

  const toggleOpen = (id: string) => {
    setOpenLinkIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Shared document list — the documents tab already fetches this and
  // react-query de-duplicates by query key, so no extra network hop.
  // We use it to surface the files ingested under each linked repo.
  const documentsQuery = trpc.document.listByAssessment.useQuery(
    { assessmentId },
    {
      // See note in `document-list.tsx`: gate against undefined
      // `assessmentId` so dev-time route transitions don't fire the query
      // with `{}` and trip the server-side Zod validator.
      enabled: !!assessmentId,
      refetchInterval: (query) => {
        const docs = query.state.data;
        if (!docs) return 4_000;
        const stillWorking = docs.some(
          (d) =>
            d.ingestStatus !== "READY" && d.ingestStatus !== "FAILED",
        );
        return stillWorking ? 4_000 : false;
      },
    },
  );

  const listQuery = trpc.repositoryLink.list.useQuery(
    { assessmentId },
    {
      refetchInterval: (query) => {
        const rows = query.state.data;
        if (!rows) return 4_000;
        const stillSyncing = rows.some(
          (r) =>
            r.ingestStatus !== "READY" && r.ingestStatus !== "FAILED",
        );
        return stillSyncing ? 4_000 : false;
      },
    },
  );

  const resyncMutation = trpc.repositoryLink.resync.useMutation({
    onSuccess: async () => {
      await utils.repositoryLink.list.invalidate({ assessmentId });
    },
  });

  const deleteMutation = trpc.repositoryLink.delete.useMutation({
    onSuccess: async () => {
      // Invalidate both lists — the repo card list and the documents
      // tab list (child Documents disappear with the link).
      await Promise.all([
        utils.repositoryLink.list.invalidate({ assessmentId }),
        utils.document.listByAssessment.invalidate({ assessmentId }),
      ]);
    },
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Linked repositories</h2>
          <p className="text-xs text-muted-foreground">
            Pull a GitHub repo into this assessment. Credentials are
            encrypted at rest (ADR-0009).
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => setModalOpen(true)}
        >
          Link repository
        </Button>
      </div>

      {listQuery.isLoading ? (
        <Skeleton className="h-20 w-full" />
      ) : listQuery.data && listQuery.data.length > 0 ? (
        <div className="space-y-2">
          {listQuery.data.map((link) => {
            const open = openLinkIds.has(link.id);
            const children = (documentsQuery.data ?? [])
              .filter(
                (d) =>
                  link.parentDocumentId != null &&
                  d.parentDocumentId === link.parentDocumentId,
              )
              .slice()
              .sort((a, b) => a.filename.localeCompare(b.filename));
            const readyCount = children.filter(
              (c) => c.ingestStatus === "READY",
            ).length;
            const failedCount = children.filter(
              (c) => c.ingestStatus === "FAILED",
            ).length;
            const inFlightCount = children.length - readyCount - failedCount;
            const canExpand =
              link.parentDocumentId != null && children.length > 0;
            return (
            <div key={link.id} className="space-y-2">
            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                {canExpand ? (
                  <button
                    type="button"
                    onClick={() => toggleOpen(link.id)}
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
                        <span className="truncate">{link.url}</span>
                        <span
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${statusTone(
                            link.ingestStatus,
                          )}`}
                        >
                          {statusLabel(link.ingestStatus)}
                        </span>
                      </CardTitle>
                      <CardDescription>
                        {link.provider} · {link.authMethod}
                        {link.lastSyncedAt ? (
                          <>
                            {" · last synced "}
                            {new Date(link.lastSyncedAt).toLocaleString(
                              undefined,
                              { dateStyle: "medium", timeStyle: "short" },
                            )}
                          </>
                        ) : (
                          " · never synced"
                        )}
                        {" · "}
                        {children.length} file
                        {children.length === 1 ? "" : "s"}
                        {" · "}
                        {readyCount} ready
                        {inFlightCount > 0
                          ? ` · ${inFlightCount} in flight`
                          : ""}
                        {failedCount > 0 ? ` · ${failedCount} failed` : ""}
                      </CardDescription>
                    </div>
                  </button>
                ) : (
                  <div className="min-w-0 flex-1">
                    <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                      <span className="truncate">{link.url}</span>
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${statusTone(
                          link.ingestStatus,
                        )}`}
                      >
                        {statusLabel(link.ingestStatus)}
                      </span>
                    </CardTitle>
                    <CardDescription>
                      {link.provider} · {link.authMethod}
                      {link.lastSyncedAt ? (
                        <>
                          {" · last synced "}
                          {new Date(link.lastSyncedAt).toLocaleString(
                            undefined,
                            { dateStyle: "medium", timeStyle: "short" },
                          )}
                        </>
                      ) : (
                        " · never synced"
                      )}
                    </CardDescription>
                  </div>
                )}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={
                      resyncMutation.isPending ||
                      deleteMutation.isPending ||
                      link.ingestStatus === "PENDING" ||
                      link.ingestStatus === "EXTRACTING"
                    }
                    onClick={() =>
                      resyncMutation.mutate({ linkId: link.id })
                    }
                  >
                    Re-sync now
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={
                      deleteMutation.isPending ||
                      resyncMutation.isPending ||
                      link.ingestStatus === "PENDING" ||
                      link.ingestStatus === "EXTRACTING"
                    }
                    onClick={() => {
                      const ok = window.confirm(
                        `Delete this linked repository?\n\n${link.url}\n\nThis removes the link, any ingested documents, and all evidence chunks derived from them. The action is irreversible.`,
                      );
                      if (ok) deleteMutation.mutate({ linkId: link.id });
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </CardHeader>
              {(resyncMutation.error &&
                resyncMutation.variables?.linkId === link.id) ||
              (deleteMutation.error &&
                deleteMutation.variables?.linkId === link.id) ? (
                <CardContent>
                  <p className="text-xs text-destructive">
                    {resyncMutation.variables?.linkId === link.id
                      ? resyncMutation.error?.message
                      : deleteMutation.error?.message}
                  </p>
                </CardContent>
              ) : null}
            </Card>
            {open && canExpand ? (
              <div className="space-y-2 border-l-2 border-muted pl-4">
                {children.map((child) => (
                  <DocumentCard
                    key={child.id}
                    doc={child}
                    assessmentId={assessmentId}
                    expanded={expandedChildId === child.id}
                    onToggle={() =>
                      setExpandedChildId(
                        expandedChildId === child.id ? null : child.id,
                      )
                    }
                  />
                ))}
              </div>
            ) : null}
            </div>
            );
          })}
        </div>
      ) : (
        <p className="rounded-md border bg-muted/20 px-4 py-4 text-center text-sm text-muted-foreground">
          No linked repositories yet.
        </p>
      )}

      {modalOpen ? (
        <LinkRepositoryModal
          assessmentId={assessmentId}
          onClose={() => setModalOpen(false)}
          onCreated={async () => {
            await utils.repositoryLink.list.invalidate({ assessmentId });
            setModalOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function LinkRepositoryModal({
  assessmentId,
  onClose,
  onCreated,
}: {
  assessmentId: string;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [pat, setPat] = useState("");
  const [branch, setBranch] = useState("main");
  const [ref, setRef] = useState("");
  const createMutation = trpc.repositoryLink.create.useMutation({
    onSuccess: () => {
      void onCreated();
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate({ assessmentId, url: url.trim(), pat: pat.trim() });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-lg border bg-background p-5 shadow-xl">
        <div className="mb-3">
          <h3 className="text-lg font-semibold">Link repository</h3>
          <p className="text-xs text-muted-foreground">
            The PAT is encrypted at rest and never echoed back. It's
            stored once per engagement in the credential vault — adding
            additional repos for the same engagement reuses it.
          </p>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1">
            <label htmlFor="repo-url" className="text-xs font-medium">
              Repository URL
            </label>
            <input
              id="repo-url"
              type="url"
              required
              placeholder="https://github.com/owner/repo"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="repo-pat" className="text-xs font-medium">
              Personal access token
            </label>
            <input
              id="repo-pat"
              type="password"
              required
              autoComplete="new-password"
              placeholder="github_pat_…"
              value={pat}
              onChange={(e) => setPat(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            />
            <p className="text-[11px] text-muted-foreground">
              Recommended: a fine-grained PAT with{" "}
              <code>Contents: Read</code> + <code>Metadata: Read</code>{" "}
              on the selected repos. (Classic PATs with <code>repo</code>{" "}
              scope still work but grant broader access than needed.)
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor="repo-branch" className="text-xs font-medium">
                Branch
              </label>
              <input
                id="repo-branch"
                type="text"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="repo-ref" className="text-xs font-medium">
                Ref (optional)
              </label>
              <input
                id="repo-ref"
                type="text"
                placeholder="commit SHA or tag"
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
              />
            </div>
          </div>

          {createMutation.error ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {createMutation.error.message}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? "Linking…" : "Link repository"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
