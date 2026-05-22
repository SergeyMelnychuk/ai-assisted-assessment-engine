import Link from "next/link";
import { KnowledgeArtifactEditor } from "@/components/admin/knowledge-artifact-editor";
import { Button } from "@/components/ui/button";
import {
  ARTIFACT_TYPES,
  type ArtifactType,
} from "../type-labels";

/**
 * New-artifact form. Accepts an optional `?type=` query param so the
 * "New {type}" button on the list page can pre-select the type.
 */
export default async function NewKnowledgeArtifactPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const params = await searchParams;
  const requestedType = params.type;
  const defaultType: ArtifactType =
    requestedType && (ARTIFACT_TYPES as readonly string[]).includes(requestedType)
      ? (requestedType as ArtifactType)
      : "QUESTION_TEMPLATE";

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            New knowledge artifact
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Creates a row at version 1. The active flag defaults to true so
            live pipelines pick it up immediately.
          </p>
        </div>
        <Link href="/admin/knowledge-base">
          <Button type="button" variant="secondary">
            Back
          </Button>
        </Link>
      </div>
      <KnowledgeArtifactEditor
        mode="create"
        initial={{
          artifactType: defaultType,
          name: "",
          description: "",
          domain: "",
          tags: [],
          content: {},
          isActive: true,
        }}
      />
    </div>
  );
}
