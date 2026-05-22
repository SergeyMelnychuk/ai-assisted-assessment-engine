"use client";

/**
 * Per-file status row shown inside the multi-file drop-zone (Phase 3
 * Week 5 gap-fill). The existing `DocumentUpload` component uploaded N
 * files sequentially but collapsed all their progress into a single
 * "Uploading…" string — users couldn't tell which file was stuck or
 * which had failed. This row is the atom the drop-zone lists.
 *
 * States map 1:1 to the ingest pipeline (Week 1, ADR-0001):
 *   queued     — client-side only, not yet POSTed to /api/documents/upload
 *   uploading  — multipart upload in flight
 *   extracting — server acknowledged; worker is extracting text
 *   chunking   — worker chunked the text; about to embed
 *   embedding  — worker is embedding chunks (Week 3)
 *   done       — terminal success
 *   failed     — terminal failure (error message shown)
 *
 * The drop-zone owns the `uploading`/`queued` transitions; the
 * `extracting`/`chunking`/`embedding`/`done`/`failed` transitions are
 * driven by polling `document.listByAssessment` after the upload lands
 * and mapping `ingestStatus` → FileUploadStatus via `mapIngestStatus`.
 */

export type FileUploadStatus =
  | "queued"
  | "uploading"
  | "extracting"
  | "chunking"
  | "embedding"
  | "done"
  | "failed";

export interface FileStatusRowProps {
  filename: string;
  sizeBytes: number;
  status: FileUploadStatus;
  error?: string | null;
}

const LABEL: Record<FileUploadStatus, string> = {
  queued: "Queued",
  uploading: "Uploading…",
  extracting: "Extracting text…",
  chunking: "Chunking…",
  embedding: "Embedding…",
  done: "Done",
  failed: "Failed",
};

const TONE: Record<FileUploadStatus, string> = {
  queued: "bg-muted text-muted-foreground",
  uploading: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  extracting: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  chunking: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  embedding: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  done: "bg-green-500/10 text-green-700 dark:text-green-300",
  failed: "bg-destructive/10 text-destructive",
};

/**
 * Map the server-side ingestStatus enum to the client-side
 * FileUploadStatus. Kept as a pure function so tests don't need to
 * boot the UI to assert the shape.
 */
export function mapIngestStatus(
  ingestStatus:
    | "PENDING"
    | "EXTRACTING"
    | "CHUNKED"
    | "EMBEDDED"
    | "READY"
    | "FAILED",
): FileUploadStatus {
  switch (ingestStatus) {
    case "PENDING":
      return "uploading";
    case "EXTRACTING":
      return "extracting";
    case "CHUNKED":
      return "chunking";
    case "EMBEDDED":
      return "embedding";
    case "READY":
      return "done";
    case "FAILED":
      return "failed";
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function FileStatusRow({
  filename,
  sizeBytes,
  status,
  error,
}: FileStatusRowProps) {
  const active =
    status === "uploading" ||
    status === "extracting" ||
    status === "chunking" ||
    status === "embedding";

  return (
    <div
      className="flex items-start gap-3 rounded-md border px-3 py-2 text-sm"
      data-status={status}
      data-testid="file-status-row"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{filename}</div>
        <div className="text-xs text-muted-foreground">
          {formatSize(sizeBytes)}
        </div>
        {status === "failed" && error ? (
          <div className="mt-1 text-xs text-destructive">{error}</div>
        ) : null}
      </div>
      <span
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${TONE[status]}`}
      >
        {active ? (
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
        ) : null}
        {LABEL[status]}
      </span>
    </div>
  );
}
