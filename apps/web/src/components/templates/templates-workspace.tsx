"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TemplateBindingEditor } from "./binding-editor";

type TemplateKind =
  | "ESTIMATION"
  | "DELIVERABLE_REPORT"
  | "DELIVERABLE_PRESENTATION"
  | "EXECUTIVE_SUMMARY"
  | "ASSESSMENT_REPORT"
  | "RISK_REGISTER"
  | "TARGET_STATE"
  | "ROADMAP"
  | "TEAM_PROPOSAL"
  | "ESTIMATE"
  | "ASSUMPTIONS_GAPS"
  | "SOW_DRAFT"
  | "GREENFIELD_DISCOVERY";

// Labels grouped logically — the upload form renders them in this
// order so the user sees WBS first, then per-deliverable-type kinds,
// then the generic fallbacks at the bottom.
const KIND_LABELS: Record<TemplateKind, string> = {
  ESTIMATION: "WBS workbook (.xlsx)",
  EXECUTIVE_SUMMARY: "Executive summary (deck)",
  ASSESSMENT_REPORT: "Assessment report",
  RISK_REGISTER: "Risk register",
  TARGET_STATE: "Target state (deck)",
  ROADMAP: "Roadmap",
  TEAM_PROPOSAL: "Team proposal",
  ESTIMATE: "Estimate",
  ASSUMPTIONS_GAPS: "Assumptions & gaps",
  SOW_DRAFT: "Statement of work (draft)",
  GREENFIELD_DISCOVERY: "Greenfield discovery",
  DELIVERABLE_REPORT: "Generic report (.docx) — fallback",
  DELIVERABLE_PRESENTATION: "Generic deck (.pptx) — fallback",
};

/**
 * Templates workspace — list + upload + lifecycle actions on a single
 * page. The binding editor sits in a side panel that opens when the
 * user clicks "Edit binding"; until they approve, the row stays in
 * PROPOSED and won't be picked up by the estimation/deliverable
 * workers.
 */
export function TemplatesWorkspace({
  engagementId,
}: {
  // `null` = workspace-defaults workspace (admin-only surface). The
  // tRPC list query accepts an undefined engagementId and returns
  // workspace defaults only — see template router for the OR clause.
  engagementId: string | null;
}) {
  const utils = trpc.useUtils();
  // Toggle controlling whether archived templates are listed. Default
  // off — archived rows are noise on the day-to-day view; flipping the
  // toggle pulls them in alongside the live ones, with the destructive
  // actions (Restore / Delete) gated behind the same authz the server
  // already enforces via `assertTemplateMutationAccess`.
  const [showArchived, setShowArchived] = useState(false);
  // Auto-poll while any row is still in `bindingStatus === "pending"`.
  // The proposer runs in the background and writes back to the
  // Template row + audit log; we just refetch on a 5s cadence until
  // every row is settled, then drop polling.
  const list = trpc.template.list.useQuery(
    engagementId
      ? { engagementId, includeArchived: showArchived }
      : { includeArchived: showArchived },
    {
      refetchInterval: (query) => {
        const data = query.state.data;
        if (!data) return false;
        return data.some((r) => r.bindingStatus === "pending") ? 5000 : false;
      },
    },
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  // Two-click confirm for Delete — same UX pattern as the document
  // delete button. Tracks which row id is currently in "really delete?"
  // state. Null = no confirm pending.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // Client-side search. The list is short (per-engagement uploads +
  // workspace defaults), so we filter the already-fetched data
  // in-memory rather than round-tripping. Matches name, filename, and
  // the human kind label, all case-insensitive.
  const [searchQuery, setSearchQuery] = useState("");

  const refresh = () => utils.template.list.invalidate();

  const approve = trpc.template.approve.useMutation({ onSuccess: refresh });
  const deprecate = trpc.template.deprecate.useMutation({ onSuccess: refresh });
  const archive = trpc.template.archive.useMutation({ onSuccess: refresh });
  const restore = trpc.template.restore.useMutation({ onSuccess: refresh });
  const del = trpc.template.delete.useMutation({
    onSuccess: () => {
      setConfirmDeleteId(null);
      refresh();
    },
  });
  const reproposeBinding = trpc.template.reproposeBinding.useMutation({
    onSuccess: refresh,
  });

  return (
    <div className="space-y-6">
      <UploadPanel engagementId={engagementId} onUploaded={refresh} />

      <div>
        <h2 className="mb-2 text-base font-semibold">Available templates</h2>
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Input
            type="search"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              // Drop any in-flight confirm when the filter changes —
              // the row in question may not even be visible anymore.
              setConfirmDeleteId(null);
            }}
            placeholder="Search by name, filename, or kind…"
            className="sm:max-w-xs"
            aria-label="Filter templates"
          />
          <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="h-3.5 w-3.5"
              checked={showArchived}
              onChange={(e) => {
                setShowArchived(e.target.checked);
                setConfirmDeleteId(null);
              }}
            />
            Show archived
          </label>
        </div>
        {(() => {
          // Apply the client-side search filter to the fetched rows.
          // Match against name, filename, and the kind's display label;
          // empty query passes everything through.
          const q = searchQuery.trim().toLowerCase();
          const allRows = list.data ?? [];
          const filteredRows = q
            ? allRows.filter((r) => {
                const kindLabel = (KIND_LABELS[r.kind] ?? r.kind).toLowerCase();
                return (
                  r.name.toLowerCase().includes(q) ||
                  r.filename.toLowerCase().includes(q) ||
                  kindLabel.includes(q)
                );
              })
            : allRows;
          if (list.isLoading) {
            return <p className="text-sm text-muted-foreground">Loading…</p>;
          }
          if (allRows.length === 0) {
            return (
              <p className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
                No templates yet. Upload a workbook or document above.
              </p>
            );
          }
          if (filteredRows.length === 0) {
            return (
              <p className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
                No templates match{" "}
                <span className="font-medium">&ldquo;{searchQuery}&rdquo;</span>
                . Try a different search, or clear the filter.
              </p>
            );
          }
          return (
          <ul className="divide-y rounded-md border">
            {filteredRows.map((row) => {
              const isArchived = row.archivedAt !== null;
              return (
              <li
                key={row.id}
                className={
                  "flex items-center justify-between gap-3 p-3 " +
                  (isArchived ? "bg-muted/40" : "")
                }
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span
                      className={
                        "truncate " +
                        (isArchived ? "text-muted-foreground line-through" : "")
                      }
                    >
                      {row.name}
                    </span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {row.version}
                    </span>
                    <span
                      className={
                        "rounded px-1.5 py-0.5 text-xs " +
                        (row.status === "APPROVED"
                          ? "bg-green-100 text-green-800"
                          : row.status === "PROPOSED"
                            ? "bg-amber-100 text-amber-800"
                            : "bg-gray-100 text-gray-700")
                      }
                    >
                      {row.status}
                    </span>
                    {row.scope === "workspace" ? (
                      <span className="rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-800">
                        workspace default
                      </span>
                    ) : null}
                    {isArchived ? (
                      <span className="rounded bg-gray-200 px-1.5 py-0.5 text-xs text-gray-700">
                        archived
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {KIND_LABELS[row.kind] ?? row.kind} · {row.filename} ·{" "}
                    {(row.fileSize / 1024).toFixed(0)} KB · uploaded{" "}
                    {new Date(row.createdAt).toLocaleDateString()}
                    {isArchived && row.archivedAt ? (
                      <>
                        {" "}
                        · archived{" "}
                        {new Date(row.archivedAt).toLocaleDateString()}
                      </>
                    ) : null}
                  </div>
                  {!isArchived ? (
                    <>
                      <BindingStatusLine status={row.bindingStatus} />
                      {row.bindingStatus === "failed" && row.bindingError ? (
                        <div className="mt-1 text-xs text-destructive">
                          {row.bindingError}
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {isArchived ? (
                    // Archived rows: Restore + Delete only. Two-click
                    // confirm on Delete because it's irreversible and
                    // takes the MinIO object + binding history with it.
                    <>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => restore.mutate({ id: row.id })}
                        disabled={
                          restore.isPending &&
                          restore.variables?.id === row.id
                        }
                      >
                        {restore.isPending &&
                        restore.variables?.id === row.id
                          ? "Restoring…"
                          : "Restore"}
                      </Button>
                      {confirmDeleteId === row.id ? (
                        <>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => del.mutate({ id: row.id })}
                            disabled={del.isPending}
                          >
                            {del.isPending && del.variables?.id === row.id
                              ? "Deleting…"
                              : "Really delete?"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={del.isPending}
                            onClick={() => setConfirmDeleteId(null)}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setConfirmDeleteId(row.id)}
                        >
                          Delete
                        </Button>
                      )}
                    </>
                  ) : (
                    // Live rows: the existing action set.
                    <>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setEditingId(row.id)}
                      >
                        {row.hasBinding ? "Edit binding" : "Review binding"}
                      </Button>
                      {row.bindingStatus === "failed" ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            reproposeBinding.mutate({ id: row.id })
                          }
                          disabled={reproposeBinding.isPending}
                        >
                          {reproposeBinding.isPending &&
                          reproposeBinding.variables?.id === row.id
                            ? "Retrying…"
                            : "Retry AI binding"}
                        </Button>
                      ) : null}
                      {row.status === "PROPOSED" && row.hasBinding ? (
                        <Button
                          size="sm"
                          onClick={() => approve.mutate({ id: row.id })}
                          disabled={approve.isPending}
                        >
                          Approve
                        </Button>
                      ) : null}
                      {row.status === "APPROVED" ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => deprecate.mutate({ id: row.id })}
                          disabled={deprecate.isPending}
                        >
                          Deprecate
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => archive.mutate({ id: row.id })}
                        disabled={archive.isPending}
                      >
                        Archive
                      </Button>
                    </>
                  )}
                </div>
              </li>
              );
            })}
          </ul>
          );
        })()}
      </div>

      <RecentFills engagementId={engagementId} />

      {editingId ? (
        <TemplateBindingEditor
          templateId={editingId}
          onClose={() => setEditingId(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * "Recent fills" history list — surfaces the last 20 populated outputs
 * across templates the caller can see, with a download link straight
 * to each output Document. Hides itself entirely when there is no
 * fill history (the section is dead weight on a fresh workspace).
 */
function RecentFills({ engagementId }: { engagementId: string | null }) {
  const fills = trpc.template.recentFillsForEngagement.useQuery(
    engagementId ? { engagementId, limit: 20 } : { limit: 20 },
    { refetchInterval: 15_000 },
  );
  // Same client-side search pattern as the templates list above —
  // matches the source template name, the produced file's name, and
  // the kind label, all case-insensitive.
  const [searchQuery, setSearchQuery] = useState("");

  if (fills.isLoading) {
    return (
      <div>
        <h2 className="mb-2 text-base font-semibold">Recent fills</h2>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  const rows = fills.data ?? [];
  if (rows.length === 0) {
    return null;
  }

  // Match against the source template name + version, the produced
  // document's filename, and the kind's display label.
  const q = searchQuery.trim().toLowerCase();
  const filteredRows = q
    ? rows.filter((f) => {
        const docName = f.outputDocument?.filename.toLowerCase() ?? "";
        const tplName = f.template.name.toLowerCase();
        const tplVersion = f.template.version.toLowerCase();
        const kindLabel = (
          KIND_LABELS[f.template.kind as TemplateKind] ?? f.template.kind
        ).toLowerCase();
        return (
          tplName.includes(q) ||
          tplVersion.includes(q) ||
          docName.includes(q) ||
          kindLabel.includes(q)
        );
      })
    : rows;

  return (
    <div>
      <h2 className="mb-2 text-base font-semibold">Recent fills</h2>
      <div className="mb-3">
        <Input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search fills by template, file, or kind…"
          className="sm:max-w-xs"
          aria-label="Filter recent fills"
        />
      </div>
      {filteredRows.length === 0 ? (
        <p className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
          No fills match{" "}
          <span className="font-medium">&ldquo;{searchQuery}&rdquo;</span>. Try
          a different search, or clear the filter.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {filteredRows.map((f) => {
            const doc = f.outputDocument;
            if (!doc) return null;
            return (
              <li
                key={f.id}
                className="flex items-center justify-between gap-3 p-3 text-sm"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 font-medium">
                    <span className="truncate">{f.template.name}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {f.template.version}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {KIND_LABELS[f.template.kind as TemplateKind] ??
                      f.template.kind}{" "}
                    · {doc.filename} · {(doc.fileSize / 1024).toFixed(0)} KB ·{" "}
                    {new Date(f.filledAt).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </div>
                </div>
                <a
                  href={`/api/documents/${doc.id}/download?download=1`}
                  className="shrink-0 text-sm font-medium text-primary underline-offset-2 hover:underline"
                >
                  Download
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Inline status line for the proposer state on a template row.
 *  - "ready"   → render nothing (the status pill is enough).
 *  - "pending" → small CSS spinner + "AI is mapping your template…"
 *  - "failed"  → red text "AI binding failed — retry available"
 *
 * The spinner is a plain CSS ring (no new dependency). Agent F will
 * hang the retry button off `bindingStatus === "failed"`.
 */
function BindingStatusLine({
  status,
}: {
  status: "ready" | "pending" | "failed";
}) {
  if (status === "ready") return null;
  if (status === "pending") {
    return (
      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
        <span
          aria-hidden="true"
          className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground"
        />
        <span>AI is mapping your template…</span>
      </div>
    );
  }
  return (
    <div className="mt-1 text-xs text-red-600">
      AI binding failed — retry available
    </div>
  );
}

/**
 * Multipart upload form. Posts straight to `/api/templates/upload`
 * because tRPC isn't great at binary payloads. On success it
 * invalidates the list so the new PROPOSED row appears immediately;
 * the AI binding proposer runs in the background and will populate
 * `bindingJson` shortly.
 */
function UploadPanel({
  engagementId,
  onUploaded,
}: {
  engagementId: string | null;
  onUploaded: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<TemplateKind>("ESTIMATION");
  const [name, setName] = useState("");
  const [version, setVersion] = useState("v1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = useMemo(
    () =>
      ".xlsx,.docx,.pptx," +
      [
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ].join(","),
    [],
  );

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Pick a file first.");
      return;
    }
    const fd = new FormData();
    fd.set("file", file);
    // Omit engagementId entirely for workspace-default uploads — the
    // upload route treats absence as "workspace default" (admin-only).
    if (engagementId) fd.set("engagementId", engagementId);
    fd.set("kind", kind);
    if (name.trim()) fd.set("name", name.trim());
    if (version.trim()) fd.set("version", version.trim());
    setBusy(true);
    try {
      const r = await fetch("/api/templates/upload", {
        method: "POST",
        body: fd,
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setError(body.error ?? `Upload failed (${r.status})`);
        return;
      }
      if (fileRef.current) fileRef.current.value = "";
      setName("");
      onUploaded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-md border bg-card p-4"
    >
      <h2 className="mb-2 text-base font-semibold">Upload a template</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        After upload, an AI proposer maps cells / placeholders to engine
        fields. Review the binding and click <em>Approve</em> to make
        the template eligible for fills.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="tpl-file">File</Label>
          <Input
            id="tpl-file"
            type="file"
            ref={fileRef}
            accept={accept}
            required
          />
        </div>
        <div>
          <Label htmlFor="tpl-kind">Kind</Label>
          <select
            id="tpl-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as TemplateKind)}
            className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {Object.entries(KIND_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="tpl-name">Display name (optional)</Label>
          <Input
            id="tpl-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Defaults to filename"
          />
        </div>
        <div>
          <Label htmlFor="tpl-version">Version</Label>
          <Input
            id="tpl-version"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder="v1"
          />
        </div>
      </div>
      {error ? (
        <p className="mt-3 text-sm text-destructive">{error}</p>
      ) : null}
      <div className="mt-3 flex justify-end">
        <Button type="submit" disabled={busy}>
          {busy ? "Uploading…" : "Upload"}
        </Button>
      </div>
    </form>
  );
}
