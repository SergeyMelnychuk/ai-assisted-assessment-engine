import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/server/db";
import { engagementAccessFilter } from "@/server/authz";
import { buildDeliverablePdf } from "@/server/services/pdf-export-service";

/**
 * PDF export proxy. Sibling of the DOCX route at
 * `/api/deliverables/[id]/export`. Same authz + audit pattern; the
 * builder lives in `pdf-export-service.ts` and uses puppeteer to
 * print a self-contained HTML page (markdown → HTML, mermaid → SVG)
 * to PDF.
 *
 * `force-dynamic` guard: this is a per-deliverable streaming response
 * and Next.js otherwise tries to cache GETs aggressively.
 */
export const dynamic = "force-dynamic";

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
    const result = await buildDeliverablePdf(db, deliverable.id);
    filename = result.filename;
    buffer = result.buffer;
  } catch (err) {
    console.error(`[export-pdf] deliverable=${deliverable.id}:`, err);
    return NextResponse.json(
      {
        error: "Failed to build PDF",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }

  // Mirror the DOCX route's "approved exports flip to EXPORTED" rule
  // so the lifecycle column doesn't drift between the two paths.
  if (deliverable.status === "APPROVED") {
    await db.deliverable
      .update({
        where: { id: deliverable.id },
        data: { status: "EXPORTED" },
      })
      .catch(() => {
        /* best-effort */
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
          format: "pdf",
          bytes: buffer.byteLength,
          originalStatus: deliverable.status,
          newStatus:
            deliverable.status === "APPROVED" ? "EXPORTED" : deliverable.status,
        },
      },
    })
    .catch(() => {
      /* best-effort */
    });

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(buffer.byteLength),
      "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
      "Cache-Control": "no-store, must-revalidate",
    },
  });
}
