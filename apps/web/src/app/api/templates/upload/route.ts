import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { TemplateKind, TemplateStatus } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { db } from "@/server/db";
import { engagementAccessFilter } from "@/server/authz";
import { putObject, buildTemplateStorageKey } from "@/server/storage/minio";
import { enqueueProposeTemplateBinding } from "@/server/queue/queue";

/**
 * Multipart upload for a customer template (.xlsx / .docx / .pptx).
 *
 * Form fields:
 *   - file:           the binary
 *   - engagementId?:  cuid — if absent, the template is a workspace
 *                     default (admin-only)
 *   - kind:           ESTIMATION | DELIVERABLE_REPORT | DELIVERABLE_PRESENTATION
 *   - name?:          display name; defaults to filename
 *   - version?:       e.g. "v1.5"; defaults to "v1"
 *
 * Side-effects:
 *   - object lands in MinIO under `templates/<id>.<ext>`
 *   - `Template` row in PROPOSED status (no binding yet)
 *   - background `propose-template-binding` job is enqueued; it
 *     populates `bindingJson` and the user reviews/approves later.
 */
const MAX_TEMPLATE_BYTES = 25 * 1024 * 1024; // 25 MB — generous

const ACCEPTED_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const form = await req.formData();
  const file = form.get("file");
  const engagementIdRaw = form.get("engagementId");
  const kindRaw = form.get("kind");
  const nameRaw = form.get("name");
  const versionRaw = form.get("version");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' field." }, { status: 400 });
  }
  if (file.size > MAX_TEMPLATE_BYTES) {
    return NextResponse.json(
      { error: `File too large (${file.size} bytes; max ${MAX_TEMPLATE_BYTES}).` },
      { status: 413 },
    );
  }
  if (!ACCEPTED_MIMES.has(file.type)) {
    return NextResponse.json(
      {
        error: `Unsupported file type ${file.type}. Accepted: .xlsx, .docx, .pptx.`,
      },
      { status: 415 },
    );
  }
  if (typeof kindRaw !== "string") {
    return NextResponse.json(
      { error: "Missing 'kind' field." },
      { status: 400 },
    );
  }
  const kind = kindRaw as TemplateKind;
  if (!Object.values(TemplateKind).includes(kind)) {
    return NextResponse.json(
      { error: `Invalid kind ${kindRaw}.` },
      { status: 400 },
    );
  }

  const engagementId =
    typeof engagementIdRaw === "string" && engagementIdRaw.length > 0
      ? engagementIdRaw
      : null;
  // Authz: workspace defaults are ADMIN-only; engagement scope
  // requires OWNER or ADMIN on the engagement.
  if (engagementId === null) {
    if (session.user.role !== "ADMIN") {
      return NextResponse.json(
        { error: "Only admins can upload workspace-default templates." },
        { status: 403 },
      );
    }
  } else {
    const engagement = await db.engagement.findFirst({
      where: { id: engagementId, ...engagementAccessFilter(session) },
      select: { id: true },
    });
    if (!engagement) {
      return NextResponse.json(
        { error: "Engagement not found or no access." },
        { status: 404 },
      );
    }
    if (session.user.role !== "ADMIN") {
      const owner = await db.engagementMember.findFirst({
        where: {
          engagementId,
          userId: session.user.id,
          role: "OWNER",
        },
        select: { id: true },
      });
      if (!owner) {
        return NextResponse.json(
          { error: "Only engagement owners or admins can upload templates." },
          { status: 403 },
        );
      }
    }
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const name = (typeof nameRaw === "string" && nameRaw.trim()) || file.name;
  const version = (typeof versionRaw === "string" && versionRaw.trim()) || "v1";

  // Pre-compute the row id so the storage key matches the row.
  const created = await db.template.create({
    data: {
      engagementId,
      kind,
      name,
      version,
      filename: file.name,
      mimeType: file.type,
      fileSize: file.size,
      storagePath: "pending",
      status: TemplateStatus.PROPOSED,
      uploadedById: session.user.id,
    },
    select: { id: true },
  });
  const storagePath = buildTemplateStorageKey(created.id, file.name);
  try {
    await putObject(storagePath, buffer, file.type);
  } catch (err) {
    // Roll back the row on storage failure so we never leave a
    // PROPOSED row pointing at a missing key.
    await db.template.delete({ where: { id: created.id } }).catch(() => {});
    return NextResponse.json(
      {
        error: "Storage upload failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
  await db.template.update({
    where: { id: created.id },
    data: { storagePath },
  });

  await db.auditLog.create({
    data: {
      userId: session.user.id,
      action: "TEMPLATE_UPLOADED",
      entityType: "Template",
      entityId: created.id,
      details: { kind, name, version, engagementId },
    },
  });

  // Kick off the AI binding proposer as a background job. It updates
  // `bindingJson` when it finishes; the UI polls.
  await enqueueProposeTemplateBinding(created.id);

  return NextResponse.json({ id: created.id });
}
