import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { Readable } from "node:stream";
import { authOptions } from "@/lib/auth";
import { db } from "@/server/db";
import { assertAssessmentAccess } from "@/server/authz";
import { getObjectStream } from "@/server/storage/minio";

/**
 * Stream a stored document back to the browser. Used both for inline
 * preview (`<img src>`) and explicit downloads (`?download=1`), with the
 * same authz check either way — we never hand out presigned S3 URLs that
 * would bypass assessment-membership enforcement.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const doc = await db.document.findUnique({
    where: { id },
    select: {
      id: true,
      filename: true,
      mimeType: true,
      storagePath: true,
      assessmentId: true,
    },
  });
  if (!doc) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  try {
    await assertAssessmentAccess(db, session, doc.assessmentId);
  } catch {
    // Collapse forbidden to 404 to avoid leaking document existence.
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  const { body, contentType, contentLength } = await getObjectStream(
    doc.storagePath,
  );

  const headers: Record<string, string> = {
    "Content-Type": contentType ?? doc.mimeType ?? "application/octet-stream",
  };
  if (contentLength !== undefined) {
    headers["Content-Length"] = String(contentLength);
  }
  if (req.nextUrl.searchParams.get("download") === "1") {
    const safe = doc.filename.replace(/[^\w.\-]+/g, "_");
    headers["Content-Disposition"] = `attachment; filename="${safe}"`;
  } else {
    headers["Content-Disposition"] = `inline; filename="${doc.filename.replace(/"/g, "")}"`;
  }

  // Node Readable → web ReadableStream via the built-in adapter. Works in
  // the Next.js edge/node runtime without any extra shim.
  const webStream = Readable.toWeb(body) as unknown as ReadableStream;
  return new NextResponse(webStream, { headers });
}
