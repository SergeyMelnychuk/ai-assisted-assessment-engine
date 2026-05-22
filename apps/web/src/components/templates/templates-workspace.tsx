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
  // Auto-poll while any row is still in `bindingStatus === "pending"`.
  // The proposer runs in the background and writes back to the
  // Template row + audit log; we just refetch on a 5s cadence until
  // every row is settled, then drop polling.
  const list = trpc.template.list.useQuery(
    engagementId
      ? { engagementId, includeArchived: false }
      : { includeArchived: false },
    {
      refetchInterval: (query) => {
        const data = query.state.data;
        if (!data) return false;
        return data.some((r) => r.bindingStatus === "pending") ? 5000 : false;
      },
    },
  );
  const [editingId, setEditingId] = useState<string | null>(null);

  const refresh = () => utils.template.list.invalidate();

  const approve = trpc.template.approve.useMutation({ onSuccess: refresh });
  const deprecate = trpc.template.deprecate.useMutation({ onSuccess: refresh });
  const archive = trpc.template.archive.useMutation({ onSuccess: refresh });
  const reproposeBinding = trpc.template.reproposeBinding.useMutation({
    onSuccess: refresh,
  });

  return (
    <div className="space-y-6">
      <UploadPanel engagementId={engagementId} onUploaded={refresh} />

      <div>
        <h2 className="mb-2 text-base font-semibold">Available templates</h2>
        {list.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !list.data || list.data.length === 0 ? (
          <p className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
            No templates yet. Upload a workbook or document above.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {list.data.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-3 p-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate">{row.name}</span>
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
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {KIND_LABELS[row.kind] ?? row.kind} · {row.filename} ·{" "}
                    {(row.fileSize / 1024).toFixed(0)} KB · uploaded{" "}
                    {new Date(row.createdAt).toLocaleDateString()}
                  </div>
                  <BindingStatusLine status={row.bindingStatus} />
                  {row.bindingStatus === "failed" && row.bindingError ? (
                    <div className="mt-1 text-xs text-destructive">
                      {row.bindingError}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
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
                      onClick={() => reproposeBinding.mutate({ id: row.id })}
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
                </div>
              </li>
            ))}
          </ul>
        )}
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

  return (
    <div>
      <h2 className="mb-2 text-base font-semibold">Recent fills</h2>
      <ul className="divide-y rounded-md border">
        {rows.map((f) => {
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
