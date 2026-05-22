import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { db } from "@/server/db";
import {
  assertAssessmentAccess,
} from "@/server/authz";
import { buildStorageKey, putObject } from "@/server/storage/minio";
import {
  detectDiagramFormat,
  isImageDiagram,
  isTextBasedDiagram,
} from "@/server/services/diagram-parser";
import {
  enqueueIngestArchive,
  enqueueIngestDiagram,
  enqueueIngestDocument,
} from "@/server/queue/queue";
import { detectArchiveKind } from "@/server/workers/ingest-archive";
import { maybeAdvanceAssessmentStage } from "@/server/services/assessment-stage";
import { isAcceptableUploadMime } from "./mime";

// 20 MB — generous for RFPs with embedded diagrams but bounded enough to
// keep the upload path on a single request. Beyond this we'd want chunked
// uploads or a direct-to-S3 presigned PUT; out of scope for MVP.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

// Match the DocumentType Prisma enum at the edge so the DB constraint
// can't surprise us. `OTHER` is the safe fallback the UI uses when the
// uploader doesn't know what to pick.
const UPLOAD_TYPES = [
  "RFP",
  "ARCHITECTURE_DOC",
  "NFR_DOC",
  "BACKLOG",
  "API_SPEC",
  "DIAGRAM_STRUCTURIZR",
  "DIAGRAM_MERMAID",
  "DIAGRAM_PLANTUML",
  "DIAGRAM_WEBSEQUENCE",
  "DIAGRAM_IMAGE",
  "DIAGRAM_SVG",
  "DIAGRAM_OTHER",
  "MEETING_NOTES",
  "INCIDENT_SUMMARY",
  "SECURITY_DOC",
  "OPERATIONAL_MANUAL",
  "MIGRATION_NOTES",
  "PROPOSAL",
  "OTHER",
] as const;

const formSchema = z.object({
  assessmentId: z.string().cuid(),
  // The client may leave this off; we'll infer from detected format below.
  uploadType: z.enum(UPLOAD_TYPES).optional(),
  // Optional domain tag — when set, the ingest worker stamps every
  // chunk of this document with the chosen domain instead of the
  // default catch-all bucket. Free-form string so we don't have to
  // ship the activeDomains enum to the API; the chunker writes it
  // verbatim and the retriever / dropdown only ever match exact
  // strings.
  domain: z.string().min(1).max(120).optional(),
});

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data" },
      { status: 400 },
    );
  }

  // Multi-file support (Phase 3 Week 5): the client may send either a
  // single `file` field (back-compat) or one-or-more `files` fields in
  // the same multipart request. We collect everything into a single
  // array so the downstream per-file pipeline runs once per file.
  const collected: File[] = [];
  const multi = formData.getAll("files");
  for (const entry of multi) {
    if (entry instanceof File) collected.push(entry);
  }
  const single = formData.get("file");
  if (single instanceof File) collected.push(single);

  if (collected.length === 0) {
    return NextResponse.json(
      { error: "Missing 'file' or 'files' field" },
      { status: 400 },
    );
  }

  const parsed = formSchema.safeParse({
    assessmentId: formData.get("assessmentId"),
    uploadType: formData.get("uploadType") ?? undefined,
    domain: formData.get("domain") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid form fields", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Authorization: assessment must belong to an engagement the caller can
  // access. Same NOT_FOUND-vs-FORBIDDEN pattern as tRPC.
  try {
    await assertAssessmentAccess(db, session, parsed.data.assessmentId);
  } catch {
    return NextResponse.json({ error: "Assessment not found" }, { status: 404 });
  }

  // Multi-file path: process each file independently, building an
  // accepted / rejected summary. A single-file request still runs this
  // loop once and returns the single-document shape for back-compat
  // (`documentId` / `filename` at the top level).
  if (collected.length > 1) {
    const outcome = await processMultipleFiles(
      collected,
      parsed.data.assessmentId,
      parsed.data.uploadType,
      session.user.id,
      parsed.data.domain,
    );
    return NextResponse.json(outcome, {
      // 207-ish semantics via 200 with per-file status rows. We stick to
      // 200 so clients don't need special error handling; the per-file
      // `rejected` array carries the reasons.
      status: 200,
    });
  }

  const file = collected[0]!;
  if (file.size === 0) {
    return NextResponse.json(
      { error: "File is empty" },
      { status: 400 },
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error: `File exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit`,
      },
      { status: 413 },
    );
  }

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Sample the first ~512 bytes for format inspection — cheap and enough
  // to catch Mermaid/PlantUML/Structurizr headers without loading the
  // whole file into the detector.
  const contentSample = buffer.toString("utf8", 0, Math.min(buffer.length, 512));
  const detectedFormat = detectDiagramFormat(
    file.name,
    file.type,
    contentSample,
  );
  const isDiagram =
    isTextBasedDiagram(detectedFormat) || isImageDiagram(detectedFormat);

  // Archive detection runs before the Document row is created so we
  // can flag the parent as an archive upfront. Magic bytes are
  // authoritative — sniffed from the same 512-byte head as the
  // diagram detector above.
  const archiveKind = detectArchiveKind(
    buffer.subarray(0, Math.min(buffer.length, 512)),
    file.type,
    file.name,
  );
  const isArchive = archiveKind !== "unknown";

  // Pre-compute the Document row so we have a cuid to namespace the
  // storage key under. Create the row in PENDING first — if the S3 put
  // fails we clean it up rather than leaving a ghost PROCESSED row.
  const documentIdRow = await db.document.create({
    data: {
      assessmentId: parsed.data.assessmentId,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      storagePath: "pending",
      fileSize: file.size,
      uploadType:
        parsed.data.uploadType ??
        (isDiagram ? mapFormatToUploadType(detectedFormat) : "OTHER"),
      domain: parsed.data.domain ?? null,
      // `ingestStatus` is the Week 1 canonical column; `processingStatus`
      // stays in sync for the legacy retry surface.
      ingestStatus: "PENDING",
      processingStatus: "PENDING",
      uploadedById: session.user.id,
    },
  });

  const storageKey = buildStorageKey(
    parsed.data.assessmentId,
    documentIdRow.id,
    file.name,
  );

  try {
    await putObject(storageKey, buffer, file.type || "application/octet-stream");
  } catch (err) {
    // Roll back the PENDING row. A future background janitor could also
    // reclaim orphans but explicit cleanup is clearer here.
    await db.document.delete({ where: { id: documentIdRow.id } }).catch(() => {});
    return NextResponse.json(
      {
        error: "Storage upload failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }

  await db.document.update({
    where: { id: documentIdRow.id },
    data: { storagePath: storageKey },
  });

  // First evidence in → nudge SETUP into INTAKE so the dashboard
  // reflects that intake is underway. Monotonic: a doc dropped on a
  // DRAFTING assessment leaves the stage where it is.
  await maybeAdvanceAssessmentStage(db, parsed.data.assessmentId, "INTAKE", {
    trigger: "document.uploaded",
    actorUserId: session.user.id,
    extra: { documentId: documentIdRow.id },
  });

  // Fire-and-forget: the worker picks these up over Redis. The HTTP
  // response returns as soon as the S3 put and the PENDING row land —
  // text extraction is a worker concern, not a request concern.
  // If Redis is unreachable the document stays PENDING and we surface
  // the failure so the user can retry rather than silently orphaning it.
  try {
    if (isArchive) {
      // Archive wins over diagram — an uploaded zip containing diagrams
      // fans out through the archive pipeline, and each extracted
      // diagram re-enters the detector on its own `ingest-document`
      // child job.
      await enqueueIngestArchive(documentIdRow.id, storageKey);
    } else if (isDiagram) {
      await enqueueIngestDiagram(documentIdRow.id);
    } else {
      await enqueueIngestDocument(documentIdRow.id);
    }
  } catch (err) {
    return NextResponse.json(
      {
        documentId: documentIdRow.id,
        warning: "Uploaded but processing queue unreachable",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 202 },
    );
  }

  return NextResponse.json({
    documentId: documentIdRow.id,
    filename: documentIdRow.filename,
    isDiagram,
    isArchive,
    archiveKind: isArchive ? archiveKind : undefined,
    detectedFormat,
    processingStatus: "PENDING",
  });
}

// ─── Multi-file processing (Phase 3 Week 5) ──────────────────────────
//
// Per-file outcome so the caller can render a row for each attempted
// upload. `accepted` carries the same shape as the single-file
// response's top-level; `rejected` carries a human-readable reason.

interface AcceptedEntry {
  file: string;
  documentId: string;
  isDiagram: boolean;
  isArchive: boolean;
  archiveKind?: string;
}

interface RejectedEntry {
  file: string;
  reason: string;
}

export interface MultiUploadResult {
  accepted: AcceptedEntry[];
  rejected: RejectedEntry[];
}

async function processMultipleFiles(
  files: readonly File[],
  assessmentId: string,
  uploadType: (typeof UPLOAD_TYPES)[number] | undefined,
  userId: string,
  domain: string | undefined,
): Promise<MultiUploadResult> {
  const accepted: AcceptedEntry[] = [];
  const rejected: RejectedEntry[] = [];

  for (const file of files) {
    if (file.size === 0) {
      rejected.push({ file: file.name, reason: "File is empty" });
      continue;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      rejected.push({
        file: file.name,
        reason: `File exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit`,
      });
      continue;
    }
    if (!isAcceptableUploadMime(file.type)) {
      rejected.push({
        file: file.name,
        reason: `Unsupported MIME type: ${file.type}`,
      });
      continue;
    }

    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const sample = buffer.toString("utf8", 0, Math.min(buffer.length, 512));
      const detected = detectDiagramFormat(file.name, file.type, sample);
      const isDiagram =
        isTextBasedDiagram(detected) || isImageDiagram(detected);
      const archiveKind = detectArchiveKind(
        buffer.subarray(0, Math.min(buffer.length, 512)),
        file.type,
        file.name,
      );
      const isArchive = archiveKind !== "unknown";

      const row = await db.document.create({
        data: {
          assessmentId,
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          storagePath: "pending",
          fileSize: file.size,
          uploadType:
            uploadType ?? (isDiagram ? mapFormatToUploadType(detected) : "OTHER"),
          domain: domain ?? null,
          ingestStatus: "PENDING",
          processingStatus: "PENDING",
          uploadedById: userId,
        },
      });

      const storageKey = buildStorageKey(assessmentId, row.id, file.name);
      try {
        await putObject(storageKey, buffer, file.type || "application/octet-stream");
      } catch (err) {
        await db.document
          .delete({ where: { id: row.id } })
          .catch(() => {});
        rejected.push({
          file: file.name,
          reason: `Storage upload failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      await db.document.update({
        where: { id: row.id },
        data: { storagePath: storageKey },
      });

      try {
        if (isArchive) {
          await enqueueIngestArchive(row.id, storageKey);
        } else if (isDiagram) {
          await enqueueIngestDiagram(row.id);
        } else {
          await enqueueIngestDocument(row.id);
        }
      } catch (err) {
        rejected.push({
          file: file.name,
          reason: `Enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      accepted.push({
        file: file.name,
        documentId: row.id,
        isDiagram,
        isArchive,
        archiveKind: isArchive ? archiveKind : undefined,
      });
    } catch (err) {
      rejected.push({
        file: file.name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { accepted, rejected };
}

function mapFormatToUploadType(
  fmt: ReturnType<typeof detectDiagramFormat>,
): (typeof UPLOAD_TYPES)[number] {
  switch (fmt) {
    case "STRUCTURIZR":
      return "DIAGRAM_STRUCTURIZR";
    case "MERMAID":
      return "DIAGRAM_MERMAID";
    case "PLANTUML":
      return "DIAGRAM_PLANTUML";
    case "WEBSEQUENCEDIAGRAMS":
      return "DIAGRAM_WEBSEQUENCE";
    case "PNG":
    case "JPEG":
      return "DIAGRAM_IMAGE";
    case "SVG":
      return "DIAGRAM_SVG";
    default:
      return "DIAGRAM_OTHER";
  }
}
