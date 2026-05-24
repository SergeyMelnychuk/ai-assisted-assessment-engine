import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { Readable } from "node:stream";
import { authOptions } from "@/lib/auth";
import { db } from "@/server/db";
import { engagementAccessFilter } from "@/server/authz";
import { getObjectStream } from "@/server/storage/minio";

/**
 * Stream a Template's source file back to the browser. Mirrors the
 * pattern in `/api/documents/[id]/download` — same auth surface, same
 * download/inline toggle via `?download=1`, never hands out presigned
 * S3 URLs that would bypass auth.
 *
 * Auth rules:
 *   - Workspace-default templates (`engagementId = null`) are visible
 *     to every signed-in user.
 *   - Engagement-scoped templates require membership of the parent
 *     engagement, same predicate `template.list` uses.
 *   - Existence is collapsed to 404 on access failure so the caller
 *     can't probe template ids they don't have rights to.
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
  const tpl = await db.template.findFirst({
    where: {
      id,
      OR: [
        { engagementId: null },
        { engagement: engagementAccessFilter(session) },
      ],
    },
    select: {
      id: true,
      filename: true,
      mimeType: true,
      storagePath: true,
    },
  });
  if (!tpl) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  const { body, contentType, contentLength } = await getObjectStream(
    tpl.storagePath,
  );

  const headers: Record<string, string> = {
    "Content-Type": contentType ?? tpl.mimeType ?? "application/octet-stream",
  };
  if (contentLength !== undefined) {
    headers["Content-Length"] = String(contentLength);
  }
  if (req.nextUrl.searchParams.get("download") === "1") {
    const safe = tpl.filename.replace(/[^\w.\-]+/g, "_");
    headers["Content-Disposition"] = `attachment; filename="${safe}"`;
  } else {
    headers["Content-Disposition"] = `inline; filename="${tpl.filename.replace(/"/g, "")}"`;
  }

  const webStream = Readable.toWeb(body) as unknown as ReadableStream;
  return new NextResponse(webStream, { headers });
}
