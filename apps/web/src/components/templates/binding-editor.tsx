"use client";

import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Binding editor — opens as a side dialog. v1 is a JSON editor with
 * server-side validation; the proposer's output is already
 * schema-valid, so most users only ever tweak a cell ref or
 * placeholder. A nicer form-driven editor lands later.
 */
export function TemplateBindingEditor({
  templateId,
  onClose,
}: {
  templateId: string;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const detail = trpc.template.get.useQuery({ id: templateId });
  const save = trpc.template.saveBinding.useMutation({
    onSuccess: async () => {
      await utils.template.list.invalidate();
      await utils.template.get.invalidate({ id: templateId });
      onClose();
    },
  });

  const [draft, setDraft] = useState<string>("");
  const [parseError, setParseError] = useState<string | null>(null);

  useEffect(() => {
    if (!detail.data) return;
    const seed =
      detail.data.bindingJson ??
      ({
        version: 1,
        templateKind: detail.data.kind,
        entries: [],
      } as const);
    setDraft(JSON.stringify(seed, null, 2));
  }, [detail.data]);

  function handleSave() {
    setParseError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch (err) {
      setParseError(
        "Invalid JSON: " + (err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    save.mutate({
      id: templateId,
      // Server re-validates against the zod schema; bad shapes return
      // a typed BAD_REQUEST.
      binding: parsed as never,
    });
  }

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Edit binding</DialogTitle>
          <DialogDescription>
            Each entry maps an engine output field to a cell, named
            range, or placeholder token. The filler walks this list
            when the user runs Team &amp; estimate or generates a
            deliverable.
          </DialogDescription>
        </DialogHeader>
        {detail.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              {detail.data?.name} · {detail.data?.filename} ·{" "}
              {detail.data?.kind}
            </div>
            <textarea
              spellCheck={false}
              className="block h-[420px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            {parseError ? (
              <p className="text-sm text-destructive">{parseError}</p>
            ) : null}
            {save.error ? (
              <p className="text-sm text-destructive">
                {save.error.message}
              </p>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save binding"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
