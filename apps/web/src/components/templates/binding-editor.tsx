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
import { Textarea } from "@/components/ui/textarea";

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
  const repropose = trpc.template.reproposeBinding.useMutation({
    onSuccess: async () => {
      // Refresh the editor's view (the AI is writing the new binding
      // in a background worker, so the textarea won't update
      // immediately — but a successful enqueue means the request was
      // accepted; the next time the panel opens or detail refetches,
      // the new binding will be there). Also bounce the list so the
      // status pill flips back to PROPOSED on the row immediately
      // when an APPROVED template was reset.
      await utils.template.list.invalidate();
      await utils.template.get.invalidate({ id: templateId });
      setRegenFeedback("");
      setRegenFromScratch(false);
      setRegenConfirming(false);
    },
  });

  const [draft, setDraft] = useState<string>("");
  const [parseError, setParseError] = useState<string | null>(null);
  // Re-propose panel state. Kept separate from the JSON editor's
  // `draft` so a user can have unsaved text edits AND queue an AI
  // re-propose without one stomping on the other.
  const [regenFeedback, setRegenFeedback] = useState<string>("");
  const [regenFromScratch, setRegenFromScratch] = useState<boolean>(false);
  const [regenConfirming, setRegenConfirming] = useState<boolean>(false);

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

            {/* AI re-propose panel — kept distinct from the JSON
                editor so a reviewer who's hand-edited the binding
                can still hand it back to the AI for a refresh. */}
            <div className="space-y-3 rounded-md border border-input bg-muted/30 p-3">
              <div>
                <h3 className="text-sm font-semibold">Re-propose with AI</h3>
                <p className="text-xs text-muted-foreground">
                  Ask the AI to revise this binding. Optional feedback
                  guides the run — e.g. tell it which entries to
                  rework or which slots it missed.
                </p>
              </div>
              <Textarea
                placeholder='e.g. "Bind {{revenue}} to totals.costLow / costHigh — you picked project.industry which is wrong. Also map the Risks sheet columns to risks[*].* fields."'
                rows={3}
                value={regenFeedback}
                onChange={(e) => setRegenFeedback(e.target.value)}
                className="font-sans text-sm"
                disabled={repropose.isPending}
              />
              <label className="flex items-start gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={regenFromScratch}
                  onChange={(e) => {
                    setRegenFromScratch(e.target.checked);
                    setRegenConfirming(false);
                  }}
                  disabled={repropose.isPending}
                />
                <span>
                  <span className="font-medium text-foreground">
                    Discard current binding and start fresh.
                  </span>{" "}
                  Use this when the current binding is corrupted (bad
                  hand-edit, dropped entries) or so far off that
                  refining it would inherit the problems.
                </span>
              </label>
              {/* Adaptive confirmation. Destructive paths (APPROVED
                  status reset, or fromScratch discard) take a
                  second click — same two-click pattern used for
                  Delete buttons elsewhere. */}
              {regenConfirming ? (
                <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                  <p className="font-medium">
                    {regenFromScratch
                      ? "Discard the current binding and ask the AI to start over?"
                      : "Reset this template to PROPOSED status?"}{" "}
                    {detail.data?.status === "APPROVED"
                      ? "Past fills aren't affected; future fills pause until you re-approve."
                      : null}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() =>
                        repropose.mutate({
                          id: templateId,
                          feedback: regenFeedback.trim() || undefined,
                          fromScratch: regenFromScratch,
                        })
                      }
                      disabled={repropose.isPending}
                    >
                      {repropose.isPending
                        ? "Queueing…"
                        : "Yes, re-propose"}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setRegenConfirming(false)}
                      disabled={repropose.isPending}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      const needsConfirm =
                        regenFromScratch ||
                        detail.data?.status === "APPROVED";
                      if (needsConfirm) {
                        setRegenConfirming(true);
                      } else {
                        repropose.mutate({
                          id: templateId,
                          feedback: regenFeedback.trim() || undefined,
                          fromScratch: regenFromScratch,
                        });
                      }
                    }}
                    disabled={repropose.isPending}
                  >
                    Re-propose binding
                  </Button>
                  {repropose.isSuccess ? (
                    <span className="text-xs text-muted-foreground">
                      Queued — refresh in a few seconds to see the new
                      binding.
                    </span>
                  ) : null}
                </div>
              )}
              {repropose.error ? (
                <p className="text-sm text-destructive">
                  {repropose.error.message}
                </p>
              ) : null}
            </div>
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
