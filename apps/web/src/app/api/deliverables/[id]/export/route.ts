import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/server/db";
import { engagementAccessFilter } from "@/server/authz";
import { buildDeliverableDocx } from "@/server/services/export-service";

/**
 * DOCX export proxy. Generates the file on demand, streams it back, and
 * side-effect-flips `Deliverable.status` to EXPORTED when the caller is
 * exporting an APPROVED deliverable. Draft exports are allowed (the
 * DOCX itself ships a DRAFT watermark on non-APPROVED sections) but
 * don't flip the status — matching the task spec's "include only
 * approved sections OR mark draft sections clearly".
 *
 * Authorization: membership check on the parent assessment + strict
 * NOT_FOUND on mismatch.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const deliverable = await db.deliverable.findFirst({
    where: {
      id,
      assessment: { engagement: engagementAccessFilter(session) },
    },
    select: { id: true, status: true, assessmentId: true },
  });
  if (!deliverable) {
    return NextResponse.json(
      { error: "Deliverable not found" },
      { status: 404 },
    );
  }

  let filename: string;
  let buffer: Buffer;
  try {
    const result = await buildDeliverableDocx(db, deliverable.id);
    filename = result.filename;
    buffer = result.buffer;
  } catch (err) {
    console.error(`[export] deliverable=${deliverable.id}:`, err);
    return NextResponse.json(
      {
        error: "Failed to build DOCX",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }

  // Only flip to EXPORTED when the deliverable is genuinely approved —
  // prevents a draft download from misleading downstream "already
  // exported" UI signals.
  if (deliverable.status === "APPROVED") {
    await db.deliverable
      .update({
        where: { id: deliverable.id },
        data: { status: "EXPORTED" },
      })
      .catch(() => {
        /* best-effort — download still succeeds */
      });
  }

  await db.auditLog
    .create({
      data: {
        userId: session.user.id,
        action: "EXPORT_DELIVERABLE",
        entityType: "Deliverable",
        entityId: deliverable.id,
        details: {
          bytes: buffer.byteLength,
          originalStatus: deliverable.status,
          newStatus:
            deliverable.status === "APPROVED" ? "EXPORTED" : deliverable.status,
        },
      },
    })
    .catch(() => {
      /* audit is best-effort here */
    });

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Length": String(buffer.byteLength),
      "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
      // Don't cache — content depends on DB state that changes over time.
      "Cache-Control": "no-store, must-revalidate",
    },
  });
}
