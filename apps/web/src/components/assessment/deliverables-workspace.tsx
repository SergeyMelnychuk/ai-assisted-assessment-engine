"use client";

import { useEffect, useMemo, useState } from "react";
import type { DeliverableType, TemplateKind } from "@prisma/client";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { DeliverablePreview } from "./deliverable-preview";
import { DeliverableInFlightBanner } from "./deliverable-in-flight-banner";
import { TemplatePicker } from "@/components/templates/template-picker";
import { TemplateFillDownload } from "@/components/templates/template-fill-download";

/**
 * The per-type template kind matches the deliverable type 1:1
 * (`EXECUTIVE_SUMMARY` deliverable → `EXECUTIVE_SUMMARY` template
 * kind). Server-side resolution falls back to the legacy generic
 * `DELIVERABLE_PRESENTATION` / `DELIVERABLE_REPORT` kinds when no
 * type-specific template is uploaded — see
 * `fillAndStoreForAssessment`.
 */
function templateKindForDeliverable(t: DeliverableType): TemplateKind {
  return t as TemplateKind;
}

/**
 * The full set of deliverable types the worker accepts. Order tuned so
 * the most-used choices land first; readers can still scroll for the
 * rest. Kept in sync with `DELIVERABLE_TYPES` in
 * `routers/deliverable.ts` — drift would surface as a tRPC enum
 * mismatch on the next type-check.
 */
const DELIVERABLE_TYPE_OPTIONS: ReadonlyArray<{
  value: DeliverableType;
  label: string;
}> = [
  { value: "ASSESSMENT_REPORT", label: "Assessment report" },
  { value: "EXECUTIVE_SUMMARY", label: "Executive summary (deck)" },
  { value: "RISK_REGISTER", label: "Risk register" },
  { value: "TARGET_STATE", label: "Target state (deck)" },
  { value: "ROADMAP", label: "Roadmap" },
  { value: "TEAM_PROPOSAL", label: "Team proposal" },
  { value: "ESTIMATE", label: "Estimate" },
  { value: "ASSUMPTIONS_GAPS", label: "Assumptions & gaps" },
  { value: "SOW_DRAFT", label: "Statement of work (draft)" },
  { value: "GREENFIELD_DISCOVERY", label: "Greenfield discovery" },
];

/**
 * Client-side shell for the /deliverables page. Owns:
 *   - the generate-deliverable mutation
 *   - selection of which deliverable is currently shown
 *   - polling the list so a newly-queued run appears without a reload
 *
 * The server page handles the assessment-picker fallback; this component
 * assumes it has a valid assessmentId.
 */
export function DeliverablesWorkspace({
  assessmentId,
  engagementId,
}: {
  assessmentId: string;
  /** Optional — when present the template picker is shown so the user
   *  can override the auto-resolver. */
  engagementId?: string;
}) {
  const utils = trpc.useUtils();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [justQueued, setJustQueued] = useState(false);
  const [pendingType, setPendingType] = useState<DeliverableType>(
    "ASSESSMENT_REPORT",
  );
  const [templateId, setTemplateId] = useState<string | undefined>(undefined);
  // Reset the picked template when the deliverable type switches kinds
  // so we don't carry over a templateId that no longer matches.
  const pickerKind = templateKindForDeliverable(pendingType);
  useEffect(() => {
    setTemplateId(undefined);
  }, [pickerKind]);

  // Filter the deliverable-type dropdown to types where the customer
  // has uploaded an APPROVED template (per-type kind OR a legacy
  // generic fallback). When no engagementId is passed (popup-only
  // contexts) we show every option.
  const enabledTypesQuery =
    trpc.template.deliverableTypesWithTemplates.useQuery(
      { engagementId },
      { enabled: !!engagementId },
    );
  const enabledTypes = useMemo(() => {
    if (!engagementId) return null;
    return new Set(enabledTypesQuery.data ?? []);
  }, [engagementId, enabledTypesQuery.data]);
  const visibleTypeOptions = useMemo(
    () =>
      enabledTypes
        ? DELIVERABLE_TYPE_OPTIONS.filter((o) => enabledTypes.has(o.value))
        : DELIVERABLE_TYPE_OPTIONS,
    [enabledTypes],
  );
  // If the currently-picked deliverable type is filtered out (no
  // template for it), drop selection back to the first enabled one
  // so the dropdown never shows a stale value.
  useEffect(() => {
    if (visibleTypeOptions.length === 0) return;
    if (!visibleTypeOptions.find((o) => o.value === pendingType)) {
      setPendingType(visibleTypeOptions[0].value);
    }
  }, [visibleTypeOptions, pendingType]);

  const listQuery = trpc.deliverable.listByAssessment.useQuery(
    { assessmentId },
    { refetchInterval: 5_000 },
  );

  const generateMutation = trpc.deliverable.generate.useMutation({
    onSuccess: async () => {
      setJustQueued(true);
      await Promise.all([
        utils.deliverable.listByAssessment.invalidate({ assessmentId }),
        // Make the in-flight banner appear instantly instead of
        // waiting for the next 3 s poll tick.
        utils.deliverable.runStatus.invalidate({ assessmentId }),
      ]);
      setTimeout(() => setJustQueued(false), 4_000);
    },
  });

  // Auto-select the newest deliverable the first time the list lands. Also
  // re-select when the selected one disappears (e.g. DRAFT replaced by a
  // re-run). Pure client-side — doesn't touch the URL so back/forward
  // stays clean.
  useEffect(() => {
    const list = listQuery.data;
    if (!list || list.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !list.find((d) => d.id === selectedId)) {
      setSelectedId(list[0].id);
    }
  }, [listQuery.data, selectedId]);

  const list = listQuery.data ?? [];
  const selectedDeliverable = selectedId
    ? list.find((d) => d.id === selectedId)
    : null;
  const selectedFillKind = selectedDeliverable
    ? templateKindForDeliverable(selectedDeliverable.deliverableType)
    : null;

  return (
    <div className="space-y-4">
      <DeliverableInFlightBanner assessmentId={assessmentId} />

      {/* Run panel — mirrors `TeamEstimateRunPanel` for consistency:
          deliverable-type select + template picker + Generate button on
          one row, download link for the latest fill below. */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label htmlFor="deliverable-type" className="text-xs">
                Deliverable
              </Label>
              <select
                id="deliverable-type"
                value={pendingType}
                onChange={(e) =>
                  setPendingType(e.target.value as DeliverableType)
                }
                className="mt-1 block w-56 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                disabled={
                  generateMutation.isPending ||
                  visibleTypeOptions.length === 0
                }
              >
                {visibleTypeOptions.length === 0 ? (
                  <option value="">No template uploaded</option>
                ) : (
                  visibleTypeOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))
                )}
              </select>
              {engagementId && visibleTypeOptions.length === 0 ? (
                <p className="mt-1 max-w-xs text-[11px] text-muted-foreground">
                  Upload a template on the{" "}
                  <a
                    href={`/engagements/${engagementId}/templates`}
                    className="text-primary underline-offset-2 hover:underline"
                  >
                    Templates
                  </a>{" "}
                  tab and approve it to enable this deliverable.
                </p>
              ) : null}
            </div>
            {engagementId ? (
              <TemplatePicker
                engagementId={engagementId}
                kind={pickerKind}
                value={templateId}
                onChange={setTemplateId}
                label={
                  pickerKind === "DELIVERABLE_PRESENTATION"
                    ? "Presentation template"
                    : "Report template"
                }
              />
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={
                generateMutation.isPending ||
                visibleTypeOptions.length === 0
              }
              onClick={() =>
                generateMutation.mutate({
                  assessmentId,
                  deliverableType: pendingType,
                  templateId,
                })
              }
            >
              {generateMutation.isPending ? "Queueing…" : "Generate"}
            </Button>
            {justQueued ? (
              <span className="text-xs text-muted-foreground">
                queued — results stream in
              </span>
            ) : null}
          </div>
        </div>
        {generateMutation.error ? (
          <p className="text-xs text-destructive" role="alert">
            {generateMutation.error.message}
          </p>
        ) : null}
        <TemplateFillDownload
          assessmentId={assessmentId}
          kind={pickerKind}
        />
      </div>

      <div className="grid gap-6 md:grid-cols-[260px_1fr]">
      <aside className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Past deliverables
        </h2>
        {listQuery.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : list.length === 0 ? (
          <p className="rounded-md border bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
            No deliverables yet. Click Generate to draft an assessment report.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {list.map((d) => {
              const active = d.id === selectedId;
              return (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(d.id)}
                    className={`w-full rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                      active
                        ? "border-primary bg-primary/5"
                        : "border-input hover:bg-muted/40"
                    }`}
                  >
                    <div className="font-medium">
                      {d.deliverableType.replace(/_/g, " ").toLowerCase()}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {d.status.toLowerCase()} · {d._count.sections} sections ·{" "}
                      {d._count.diagrams} diagrams
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {new Date(d.createdAt).toLocaleString(undefined, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      <section className="space-y-3">
        {selectedId ? (
          <>
            <DeliverablePreview deliverableId={selectedId} />
            {/* When the user is browsing a past deliverable whose
                template kind differs from the type currently chosen
                in the top picker, surface the past one's filled
                output here too so the download stays one click
                away. Hides itself when no fill exists. */}
            {selectedFillKind && selectedFillKind !== pickerKind ? (
              <TemplateFillDownload
                assessmentId={assessmentId}
                kind={selectedFillKind}
              />
            ) : null}
          </>
        ) : (
          <div className="rounded-md border bg-muted/20 px-4 py-12 text-center text-sm text-muted-foreground">
            Generate a deliverable to see the preview here.
          </div>
        )}
      </section>
      </div>
    </div>
  );
}
