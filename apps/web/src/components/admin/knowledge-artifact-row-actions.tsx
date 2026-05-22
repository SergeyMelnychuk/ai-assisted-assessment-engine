"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

/**
 * Per-row action cluster: Edit link, toggle active, delete (with
 * inline confirm). Colocated with the list page — the list page is a
 * server component so these interactive bits live here as a small
 * client island.
 */
export function KnowledgeArtifactRowActions({
  id,
  isActive,
}: {
  id: string;
  isActive: boolean;
}) {
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleMutation = trpc.knowledgeArtifact.toggleActive.useMutation();
  const deleteMutation = trpc.knowledgeArtifact.delete.useMutation();

  const busy = toggleMutation.isPending || deleteMutation.isPending;

  async function onToggle() {
    setError(null);
    try {
      await toggleMutation.mutateAsync({ id });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    }
  }

  async function onDelete() {
    setError(null);
    try {
      await deleteMutation.mutateAsync({ id });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      setConfirmDelete(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center gap-1">
        <Link href={`/admin/knowledge-base/${id}/edit`}>
          <Button type="button" variant="secondary" size="sm">
            Edit
          </Button>
        </Link>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onToggle}
          disabled={busy}
          title={isActive ? "Deactivate" : "Reactivate"}
        >
          {isActive ? "Deactivate" : "Activate"}
        </Button>
        {confirmDelete ? (
          <>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={onDelete}
              disabled={busy}
            >
              Confirm
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDelete(false)}
              disabled={busy}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setConfirmDelete(true)}
            disabled={busy}
            className="text-destructive hover:bg-destructive/10"
          >
            Delete
          </Button>
        )}
      </div>
      {error ? (
        <span className="text-xs text-destructive">{error}</span>
      ) : null}
    </div>
  );
}
