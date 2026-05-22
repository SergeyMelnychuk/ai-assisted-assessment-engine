"use client";

import { useCallback, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { domainLabel } from "@/lib/domain-labels";
import {
  FileStatusRow,
  type FileUploadStatus,
} from "./file-status-row";

interface PerFileState {
  id: string;
  filename: string;
  sizeBytes: number;
  status: FileUploadStatus;
  error: string | null;
}

/**
 * Drag-and-drop uploader that POSTs multipart form data to the upload
 * route. On success invalidates the parent list so the new row animates
 * in with its PENDING status.
 */
export function DocumentUpload({
  assessmentId,
  onUploaded,
}: {
  assessmentId: string;
  onUploaded?: () => void;
}) {
  const utils = trpc.useUtils();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-file state — one row per file in-flight. Lets users see exactly
  // which file is stuck / which failed, rather than a single collapsed
  // "Uploading…" for the whole batch. (Phase 3 Week 5 gap-fill.)
  const [perFile, setPerFile] = useState<PerFileState[]>([]);
  // Optional domain tag the user picks for this batch. Empty string =
  // "auto / no domain"; the chunker falls back to its catch-all bucket.
  const [domain, setDomain] = useState<string>("");
  // Source the dropdown options from the assessment itself so we never
  // surface a domain that wasn't activated at Setup.
  const assessmentQuery = trpc.assessment.getById.useQuery({
    id: assessmentId,
  });
  const activeDomains = assessmentQuery.data?.activeDomains ?? [];

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      setError(null);
      setUploading(true);

      // Seed per-file rows as `queued` up-front so the user sees the
      // full batch immediately, then flip to `uploading` as we iterate.
      const seeded: PerFileState[] = list.map((f, i) => ({
        id: `${Date.now()}-${i}-${f.name}`,
        filename: f.name,
        sizeBytes: f.size,
        status: "queued",
        error: null,
      }));
      setPerFile((prev) => [...seeded, ...prev]);

      try {
        // Upload sequentially so we surface per-file errors and don't
        // blast the Anthropic/S3 endpoints with parallel calls in dev.
        for (let i = 0; i < list.length; i++) {
          const file = list[i];
          const rowId = seeded[i].id;
          setPerFile((prev) =>
            prev.map((r) =>
              r.id === rowId ? { ...r, status: "uploading" } : r,
            ),
          );

          const fd = new FormData();
          fd.append("assessmentId", assessmentId);
          fd.append("file", file);
          if (domain) fd.append("domain", domain);
          const res = await fetch("/api/documents/upload", {
            method: "POST",
            body: fd,
          });
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            const msg =
              body?.error ?? `Upload failed (${res.status}) for ${file.name}`;
            setPerFile((prev) =>
              prev.map((r) =>
                r.id === rowId
                  ? { ...r, status: "failed", error: msg }
                  : r,
              ),
            );
            throw new Error(msg);
          }
          // Upload succeeded client-side. Drop the row — the real
          // ingest status (EXTRACTING → CHUNKED → READY / FAILED)
          // renders inside `DocumentList` below, driven by the server.
          // Leaving a stale "Extracting…" row here duplicated the
          // entry and only disappeared on a hard refresh.
          setPerFile((prev) => prev.filter((r) => r.id !== rowId));
        }
        await utils.document.listByAssessment.invalidate({ assessmentId });
        onUploaded?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [assessmentId, utils, onUploaded, domain],
  );

  return (
    <div className="space-y-3">
      {activeDomains.length > 0 ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="grow">
            <Label htmlFor="upload-domain" className="text-xs">
              Tag chunks with domain
            </Label>
            <select
              id="upload-domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              disabled={uploading}
              className="mt-1 block w-full max-w-sm rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            >
              <option value="">Auto / no domain (catch-all)</option>
              {activeDomains.map((d) => (
                <option key={d} value={d}>
                  {domainLabel(d)}
                </option>
              ))}
            </select>
          </div>
          <p className="max-w-sm shrink text-[11px] text-muted-foreground">
            Picking a domain stamps every chunk of these documents with
            it. Leave on auto when the file spans multiple domains —
            it&apos;ll land in the shared bucket the analysis engine
            also reads.
          </p>
        </div>
      ) : null}
      <div
        onDragEnter={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setDragActive(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handleFiles(e.dataTransfer.files);
          }
        }}
        className={`rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragActive
            ? "border-primary bg-primary/5"
            : "border-input bg-muted/20"
        } ${uploading ? "opacity-60" : ""}`}
      >
        <p className="text-sm font-medium">
          {uploading ? "Uploading…" : "Drop files here or click to browse"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          PDF, DOCX, Markdown, text, OpenAPI (YAML/JSON), or diagrams
          (Mermaid, PlantUML, Structurizr, PNG, SVG). Up to 20MB per
          file.
        </p>
        <div className="mt-4">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            accept=".pdf,.docx,.doc,.txt,.md,.json,.yaml,.yml,.mmd,.mermaid,.puml,.plantuml,.pu,.dsl,.wsd,.png,.jpg,.jpeg,.svg,image/*,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,text/yaml,application/yaml,application/x-yaml"
            onChange={(e) => {
              if (e.target.files) handleFiles(e.target.files);
            }}
            disabled={uploading}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            Choose files
          </Button>
        </div>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {perFile.length > 0 ? (
        <div className="space-y-1.5">
          {perFile.map((row) => (
            <FileStatusRow
              key={row.id}
              filename={row.filename}
              sizeBytes={row.sizeBytes}
              status={row.status}
              error={row.error}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
