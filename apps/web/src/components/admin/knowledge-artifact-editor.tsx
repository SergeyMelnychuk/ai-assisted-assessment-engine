"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  ARTIFACT_TYPES,
  TYPE_LABELS,
  type ArtifactType,
} from "@/app/(app)/admin/knowledge-base/type-labels";

interface EditorInitialValues {
  id?: string;
  artifactType: ArtifactType;
  name: string;
  description: string;
  domain: string;
  tags: string[];
  content: unknown;
  isActive: boolean;
  version?: number;
}

/**
 * Create/edit form for a `KnowledgeArtifact`. Single form used for both
 * new-artifact and existing-artifact flows — differentiated by whether
 * `initial.id` is set. JSON payloads are edited as raw text and
 * validated client-side before submit so broken JSON never reaches the
 * server (the router accepts arbitrary JSON, but a parse failure in a
 * consumer later would be worse).
 */
export function KnowledgeArtifactEditor({
  mode,
  initial,
}: {
  mode: "create" | "edit";
  initial: EditorInitialValues;
}) {
  const router = useRouter();

  const [artifactType, setArtifactType] = useState<ArtifactType>(
    initial.artifactType,
  );
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [domain, setDomain] = useState(initial.domain);
  const [tagsText, setTagsText] = useState(initial.tags.join(", "));
  const [isActive, setIsActive] = useState(initial.isActive);
  const [contentText, setContentText] = useState(() =>
    initial.content === undefined || initial.content === null
      ? "{}"
      : JSON.stringify(initial.content, null, 2),
  );
  const [submitError, setSubmitError] = useState<string | null>(null);

  const jsonError = useMemo(() => {
    try {
      JSON.parse(contentText);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Invalid JSON";
    }
  }, [contentText]);

  const createMutation = trpc.knowledgeArtifact.create.useMutation();
  const updateMutation = trpc.knowledgeArtifact.update.useMutation();

  const busy = createMutation.isPending || updateMutation.isPending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    if (jsonError) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setSubmitError("Name is required");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contentText);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Invalid JSON");
      return;
    }
    const tags = tagsText
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    try {
      if (mode === "create") {
        const created = await createMutation.mutateAsync({
          artifactType,
          name: trimmedName,
          description,
          domain: domain.trim() ? domain.trim() : undefined,
          tags,
          // tRPC accepts any JSON-serialisable value here.
          content: parsed as never,
          isActive,
        });
        router.push(`/admin/knowledge-base`);
        router.refresh();
        // Silence unused-var lint; the created row is available if
        // we ever wire a toast.
        void created;
      } else {
        if (!initial.id) throw new Error("Missing artifact id");
        await updateMutation.mutateAsync({
          id: initial.id,
          name: trimmedName,
          description,
          domain: domain.trim() ? domain.trim() : null,
          tags,
          content: parsed as never,
          isActive,
        });
        router.push(`/admin/knowledge-base`);
        router.refresh();
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Save failed");
    }
  }

  const typeMeta = TYPE_LABELS[artifactType];

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-1">
        <Label htmlFor="artifactType">Type</Label>
        {mode === "create" ? (
          <select
            id="artifactType"
            value={artifactType}
            onChange={(e) => setArtifactType(e.target.value as ArtifactType)}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {ARTIFACT_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]?.label ?? t}
              </option>
            ))}
          </select>
        ) : (
          <Input
            id="artifactType"
            value={TYPE_LABELS[artifactType]?.label ?? artifactType}
            disabled
            readOnly
          />
        )}
        {typeMeta?.description ? (
          <p className="text-xs text-muted-foreground">{typeMeta.description}</p>
        ) : null}
        {typeMeta?.seedPath ? (
          <p className="text-xs text-muted-foreground">
            Seed source:{" "}
            <code className="rounded bg-muted px-1 py-0.5">
              {typeMeta.seedPath}
            </code>
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
          required
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="description">Description</Label>
        <Textarea
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={4000}
          rows={3}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="domain">Domain</Label>
          <Input
            id="domain"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            maxLength={120}
            placeholder="e.g. delivery-strategy"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="tags">Tags (comma-separated)</Label>
          <Input
            id="tags"
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            placeholder="e.g. cloud, aws"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          id="isActive"
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
          className="h-4 w-4"
        />
        <Label htmlFor="isActive" className="cursor-pointer">
          Active (read by live pipelines)
        </Label>
      </div>

      <div className="space-y-1">
        <div className="flex items-baseline justify-between">
          <Label htmlFor="content">Content (JSON)</Label>
          {jsonError ? (
            <span className="text-xs text-destructive">Invalid JSON</span>
          ) : (
            <span className="text-xs text-muted-foreground">
              Parses cleanly
            </span>
          )}
        </div>
        <Textarea
          id="content"
          value={contentText}
          onChange={(e) => setContentText(e.target.value)}
          rows={20}
          spellCheck={false}
          className="font-mono text-xs"
        />
        {jsonError ? (
          <p className="text-xs text-destructive">{jsonError}</p>
        ) : null}
      </div>

      {submitError ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {submitError}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={busy || Boolean(jsonError)}>
          {busy
            ? "Saving..."
            : mode === "create"
              ? "Create artifact"
              : "Save changes"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            router.push("/admin/knowledge-base");
          }}
          disabled={busy}
        >
          Cancel
        </Button>
        {mode === "edit" && initial.version !== undefined ? (
          <span className="ml-auto text-xs text-muted-foreground">
            Current version: v{initial.version} (will bump to v
            {initial.version + 1} on save)
          </span>
        ) : null}
      </div>
    </form>
  );
}
