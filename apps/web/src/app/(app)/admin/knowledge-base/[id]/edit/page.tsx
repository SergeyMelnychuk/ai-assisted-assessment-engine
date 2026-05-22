import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/server/db";
import { Button } from "@/components/ui/button";
import { KnowledgeArtifactEditor } from "@/components/admin/knowledge-artifact-editor";
import { type ArtifactType } from "../../type-labels";

export const dynamic = "force-dynamic";

/**
 * Edit an existing knowledge artifact. The artifactType is immutable
 * in the editor (changing type on a live row could silently break
 * consumers that filter by type) — create a new artifact and delete
 * the old one if you really need to re-type.
 */
export default async function EditKnowledgeArtifactPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const artifact = await db.knowledgeArtifact.findUnique({
    where: { id },
  });
  if (!artifact) notFound();

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Edit knowledge artifact
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Saving bumps <code>version</code> by 1. Consumers (scoring,
            analysis, estimation, question seeding) pick up the change on
            the next read.
          </p>
        </div>
        <Link href="/admin/knowledge-base">
          <Button type="button" variant="secondary">
            Back
          </Button>
        </Link>
      </div>
      <KnowledgeArtifactEditor
        mode="edit"
        initial={{
          id: artifact.id,
          artifactType: artifact.artifactType as ArtifactType,
          name: artifact.name,
          description: artifact.description ?? "",
          domain: artifact.domain ?? "",
          tags: artifact.tags ?? [],
          content: artifact.content,
          isActive: artifact.isActive,
          version: artifact.version,
        }}
      />
    </div>
  );
}
