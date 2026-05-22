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
import {
  ConfidenceBadge,
  ReviewBadge,
} from "@/components/analysis/review-badges";
import { ReviewStatusSelect } from "@/components/analysis/review-status-select";
import { RunEstimationButton } from "./run-estimation-button";

interface RoleAllocation {
  roleName: string;
  seniority: string;
  count: number;
  hoursLow: number;
  hoursHigh: number;
  hourlyRate: number;
  phase?: string | null;
}

/**
 * Renders the most recent Estimate for an assessment — scenario name,
 * totals, per-role breakdown (from the JSON snapshot so numbers stay
 * accurate even if RoleProposal rows are later edited), assumptions,
 * and inline edit of the totals + assumptions.
 */
export function EstimateSummary({ assessmentId }: { assessmentId: string }) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);

  const query = trpc.estimation.getLatestEstimate.useQuery(
    { assessmentId },
    { refetchInterval: 4_000 },
  );
  const updateMutation = trpc.estimation.updateEstimate.useMutation({
    onSuccess: async () => {
      await utils.estimation.getLatestEstimate.invalidate({ assessmentId });
      setEditing(false);
    },
  });

  if (query.isLoading) return <Skeleton className="h-32 w-full" />;
  if (query.error) {
    return (
      <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {query.error.message}
      </p>
    );
  }

  const estimate = query.data;
  if (!estimate) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">No estimate yet</CardTitle>
          <CardDescription>
            Generating an estimate creates both a team proposal (roles) and
            an effort/pricing summary. Requires the analysis run to have
            produced findings and domain scores.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RunEstimationButton assessmentId={assessmentId} />
        </CardContent>
      </Card>
    );
  }

  const currency = estimate.rateCard.currency;
  const allocations = Array.isArray(estimate.roleAllocations)
    ? (estimate.roleAllocations as unknown as RoleAllocation[])
    : [];
  // Decimal fields come back as strings over the wire — normalize to number
  // for the display layer. `toString()` handles both cases.
  const costLow = Number(estimate.totalCostLow.toString());
  const costHigh = Number(estimate.totalCostHigh.toString());

  return (
    <Card>
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <ConfidenceBadge value={estimate.confidence} />
          <ReviewBadge status={estimate.reviewStatus} />
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            rate card: {estimate.rateCard.name}
          </span>
        </div>
        <CardTitle className="text-base leading-snug">
          {estimate.scenarioName}
        </CardTitle>
        {!editing ? (
          // CardDescription renders as a <p> (Radix slot), which can't
          // legally contain block-level children. Use a plain div with
          // the same muted-foreground tone instead so the grid +
          // MetricBlock subtree stays valid HTML.
          <div className="text-sm text-muted-foreground">
            <div className="grid gap-3 md:grid-cols-2">
              <MetricBlock
                label="Effort"
                primary={`${formatHours(estimate.totalEffortHoursLow)}–${formatHours(estimate.totalEffortHoursHigh)}`}
                secondary={`${formatDays(estimate.totalEffortHoursLow)}–${formatDays(estimate.totalEffortHoursHigh)}`}
              />
              <MetricBlock
                label={`Cost (${currency})`}
                primary={`${formatMoney(costLow, currency)}–${formatMoney(costHigh, currency)}`}
                secondary={`blended @ ${blendedRate(estimate.totalEffortHoursLow, costLow, estimate.totalEffortHoursHigh, costHigh)}/h`}
              />
            </div>
          </div>
        ) : null}
      </CardHeader>

      {editing ? (
        <CardContent>
          <EstimateEditor
            scenarioName={estimate.scenarioName}
            assumptions={estimate.assumptions ?? ""}
            totalEffortHoursLow={estimate.totalEffortHoursLow}
            totalEffortHoursHigh={estimate.totalEffortHoursHigh}
            totalCostLow={costLow}
            totalCostHigh={costHigh}
            currency={currency}
            busy={updateMutation.isPending}
            onCancel={() => setEditing(false)}
            onSave={(next) =>
              updateMutation.mutate({ id: estimate.id, ...next })
            }
          />
        </CardContent>
      ) : (
        <CardContent className="space-y-4">
          {allocations.length > 0 ? (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Per-role breakdown
              </h4>
              <div className="mt-2 overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left">Role</th>
                      <th className="px-3 py-2 text-left">Seniority</th>
                      <th className="px-3 py-2 text-right">Count</th>
                      <th className="px-3 py-2 text-right">Hours</th>
                      <th className="px-3 py-2 text-right">Rate</th>
                      <th className="px-3 py-2 text-right">Cost range</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allocations.map((a, i) => {
                      const rLow = a.count * a.hoursLow * a.hourlyRate;
                      const rHigh = a.count * a.hoursHigh * a.hourlyRate;
                      return (
                        <tr key={i} className="border-t">
                          <td className="px-3 py-2 font-medium">{a.roleName}</td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {a.seniority.toLowerCase()}
                          </td>
                          <td className="px-3 py-2 text-right">{a.count}</td>
                          <td className="px-3 py-2 text-right">
                            {a.hoursLow}–{a.hoursHigh}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {a.hourlyRate > 0
                              ? formatMoney(a.hourlyRate, currency)
                              : "—"}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {formatMoney(rLow, currency)}–{formatMoney(rHigh, currency)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {estimate.assumptions ? (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Assumptions
              </h4>
              <p className="mt-1 whitespace-pre-wrap text-sm">
                {estimate.assumptions}
              </p>
            </div>
          ) : null}

          <div className="flex items-center justify-between">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setEditing(true)}
            >
              Edit estimate
            </Button>
            <ReviewStatusSelect
              value={estimate.reviewStatus}
              disabled={updateMutation.isPending}
              onChange={(next) =>
                updateMutation.mutate({ id: estimate.id, reviewStatus: next })
              }
            />
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function MetricBlock({
  label,
  primary,
  secondary,
}: {
  label: string;
  primary: string;
  secondary?: string;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
        {primary}
      </div>
      {secondary ? (
        <div className="text-xs text-muted-foreground">{secondary}</div>
      ) : null}
    </div>
  );
}

function EstimateEditor({
  scenarioName,
  assumptions,
  totalEffortHoursLow,
  totalEffortHoursHigh,
  totalCostLow,
  totalCostHigh,
  currency,
  busy,
  onCancel,
  onSave,
}: {
  scenarioName: string;
  assumptions: string;
  totalEffortHoursLow: number;
  totalEffortHoursHigh: number;
  totalCostLow: number;
  totalCostHigh: number;
  currency: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (next: {
    scenarioName: string;
    assumptions: string;
    totalEffortHoursLow: number;
    totalEffortHoursHigh: number;
    totalCostLow: number;
    totalCostHigh: number;
  }) => void;
}) {
  const [name, setName] = useState(scenarioName);
  const [a, setA] = useState(assumptions);
  const [hLow, setHLow] = useState(String(totalEffortHoursLow));
  const [hHigh, setHHigh] = useState(String(totalEffortHoursHigh));
  const [cLow, setCLow] = useState(String(totalCostLow));
  const [cHigh, setCHigh] = useState(String(totalCostHigh));

  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Scenario
        </label>
        <Input
          className="mt-1"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Effort hours (low)
          </label>
          <Input
            type="number"
            className="mt-1"
            value={hLow}
            onChange={(e) => setHLow(e.target.value)}
            disabled={busy}
          />
        </div>
        <div>
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Effort hours (high)
          </label>
          <Input
            type="number"
            className="mt-1"
            value={hHigh}
            onChange={(e) => setHHigh(e.target.value)}
            disabled={busy}
          />
        </div>
        <div>
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Total cost low ({currency})
          </label>
          <Input
            type="number"
            className="mt-1"
            value={cLow}
            onChange={(e) => setCLow(e.target.value)}
            disabled={busy}
          />
        </div>
        <div>
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Total cost high ({currency})
          </label>
          <Input
            type="number"
            className="mt-1"
            value={cHigh}
            onChange={(e) => setCHigh(e.target.value)}
            disabled={busy}
          />
        </div>
      </div>
      <div>
        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Assumptions
        </label>
        <Textarea
          className="mt-1 min-h-[96px]"
          value={a}
          onChange={(e) => setA(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            const n1 = Number(hLow), n2 = Number(hHigh);
            const m1 = Number(cLow), m2 = Number(cHigh);
            if (
              !Number.isFinite(n1) ||
              !Number.isFinite(n2) ||
              !Number.isFinite(m1) ||
              !Number.isFinite(m2)
            ) {
              return;
            }
            onSave({
              scenarioName: name.trim() || "Custom scenario",
              assumptions: a.trim(),
              totalEffortHoursLow: Math.round(Math.max(0, n1)),
              totalEffortHoursHigh: Math.round(Math.max(n1, n2)),
              totalCostLow: Math.max(0, m1),
              totalCostHigh: Math.max(m1, m2),
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

function formatHours(h: number): string {
  return `${new Intl.NumberFormat().format(h)}h`;
}
function formatDays(h: number): string {
  // 8h working day — standard-enough assumption for a sanity glance.
  return `${new Intl.NumberFormat().format(Math.round(h / 8))}d`;
}
function formatMoney(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${currency} ${Math.round(n).toLocaleString()}`;
  }
}
function blendedRate(hLow: number, cLow: number, hHigh: number, cHigh: number) {
  const avgH = (hLow + hHigh) / 2;
  const avgC = (cLow + cHigh) / 2;
  if (avgH <= 0) return "—";
  return `${Math.round(avgC / avgH).toLocaleString()}`;
}
