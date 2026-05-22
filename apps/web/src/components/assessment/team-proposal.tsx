"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ReviewBadge } from "@/components/analysis/review-badges";
import { ReviewStatusSelect } from "@/components/analysis/review-status-select";

const SENIORITIES = ["JUNIOR", "MID", "SENIOR", "LEAD", "PRINCIPAL"] as const;

/**
 * Render the list of AI-proposed roles with inline editing. Each row
 * shows role+seniority+count, responsibilities, and a review-status
 * dropdown. "Edit" pops a small form so the reviewer can adjust count,
 * seniority, or rewrite the justification.
 */
export function TeamProposal({ assessmentId }: { assessmentId: string }) {
  const utils = trpc.useUtils();
  const [editingId, setEditingId] = useState<string | null>(null);

  const query = trpc.estimation.listProposals.useQuery(
    { assessmentId },
    { refetchInterval: 4_000 },
  );
  const updateMutation = trpc.estimation.updateProposal.useMutation({
    onSuccess: async () => {
      await utils.estimation.listProposals.invalidate({ assessmentId });
      await utils.estimation.getLatestEstimate.invalidate({ assessmentId });
      setEditingId(null);
    },
  });
  const deleteMutation = trpc.estimation.deleteProposal.useMutation({
    onSuccess: async () => {
      await utils.estimation.listProposals.invalidate({ assessmentId });
    },
  });

  if (query.isLoading) return <Skeleton className="h-24 w-full" />;
  if (query.error) {
    return (
      <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {query.error.message}
      </p>
    );
  }

  const proposals = query.data ?? [];
  if (proposals.length === 0) {
    return (
      <p className="rounded-md border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
        No team proposals yet. Run the team &amp; estimate job to generate one.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {proposals.map((p) => {
        const isEditing = editingId === p.id;
        return (
          <Card key={p.id}>
            <CardHeader className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center rounded-full border border-input bg-background px-2 py-0.5 text-xs font-medium">
                  {p.seniority.toLowerCase()}
                </span>
                <span className="inline-flex items-center rounded-full border border-input bg-background px-2 py-0.5 text-xs">
                  count: {p.count}
                </span>
                {p.phase ? (
                  <span className="inline-flex items-center rounded-full border border-input bg-background px-2 py-0.5 text-xs text-muted-foreground">
                    phase: {p.phase}
                  </span>
                ) : null}
                <ReviewBadge status={p.reviewStatus} />
              </div>
              <CardTitle className="text-base leading-snug">
                {p.roleName}
              </CardTitle>
              <CardDescription className="whitespace-pre-wrap text-sm text-foreground">
                {p.justification}
              </CardDescription>
              {p.expertiseRequired.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {p.expertiseRequired.map((s) => (
                    <span
                      key={s}
                      className="inline-flex items-center rounded-full border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                    >
                      {s}
                    </span>
                  ))}
                </div>
              ) : null}
            </CardHeader>
            {isEditing ? (
              <CardContent>
                <ProposalEditor
                  initialSeniority={p.seniority}
                  initialCount={p.count}
                  initialJustification={p.justification}
                  initialResponsibilities={p.responsibilities}
                  busy={updateMutation.isPending}
                  onCancel={() => setEditingId(null)}
                  onSave={(next) =>
                    updateMutation.mutate({ id: p.id, ...next })
                  }
                />
              </CardContent>
            ) : (
              <CardContent className="space-y-3">
                {p.responsibilities ? (
                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Responsibilities
                    </h4>
                    <p className="mt-1 whitespace-pre-wrap text-sm">
                      {p.responsibilities}
                    </p>
                  </div>
                ) : null}
                <div className="flex items-center justify-between">
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditingId(p.id)}
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={deleteMutation.isPending}
                      onClick={() => {
                        if (confirm(`Remove ${p.roleName} from the team?`)) {
                          deleteMutation.mutate({ id: p.id });
                        }
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                  <ReviewStatusSelect
                    value={p.reviewStatus}
                    disabled={updateMutation.isPending}
                    onChange={(next) =>
                      updateMutation.mutate({
                        id: p.id,
                        reviewStatus: next,
                      })
                    }
                  />
                </div>
              </CardContent>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function ProposalEditor({
  initialSeniority,
  initialCount,
  initialJustification,
  initialResponsibilities,
  busy,
  onCancel,
  onSave,
}: {
  initialSeniority: (typeof SENIORITIES)[number];
  initialCount: number;
  initialJustification: string;
  initialResponsibilities: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (next: {
    seniority: (typeof SENIORITIES)[number];
    count: number;
    justification: string;
    responsibilities: string;
  }) => void;
}) {
  const [seniority, setSeniority] = useState(initialSeniority);
  const [count, setCount] = useState(String(initialCount));
  const [justification, setJustification] = useState(initialJustification);
  const [responsibilities, setResponsibilities] = useState(
    initialResponsibilities,
  );

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Seniority
          </label>
          <select
            className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            value={seniority}
            onChange={(e) =>
              setSeniority(e.target.value as (typeof SENIORITIES)[number])
            }
            disabled={busy}
          >
            {SENIORITIES.map((s) => (
              <option key={s} value={s}>
                {s.toLowerCase()}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Count
          </label>
          <Input
            type="number"
            min={1}
            max={50}
            step={1}
            className="mt-1"
            value={count}
            onChange={(e) => setCount(e.target.value)}
            disabled={busy}
          />
        </div>
      </div>
      <div>
        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Justification
        </label>
        <Textarea
          className="mt-1 min-h-[80px]"
          value={justification}
          onChange={(e) => setJustification(e.target.value)}
          disabled={busy}
        />
      </div>
      <div>
        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Responsibilities
        </label>
        <Textarea
          className="mt-1 min-h-[80px]"
          value={responsibilities}
          onChange={(e) => setResponsibilities(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            const n = Number(count);
            if (!Number.isFinite(n) || n < 1) return;
            onSave({
              seniority,
              count: Math.round(n),
              justification: justification.trim(),
              responsibilities: responsibilities.trim(),
            });
          }}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
