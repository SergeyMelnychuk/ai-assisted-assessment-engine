"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { domainLabel as prettyDomain } from "@/lib/domain-labels";

type AssessmentMode =
  | "EXISTING_SYSTEM"
  | "GREENFIELD"
  | "MODERNIZATION"
  | "AUDIT"
  | "PRE_IMPLEMENTATION";

// Display labels for the mode enum. Keep in sync with the Prisma enum;
// unknown codes fall through to the raw value via the `?? code` below.
const MODE_LABELS: Record<AssessmentMode, string> = {
  EXISTING_SYSTEM: "Existing system review",
  GREENFIELD: "Greenfield",
  MODERNIZATION: "Modernization",
  AUDIT: "Audit / readiness review",
  PRE_IMPLEMENTATION: "Pre-implementation discovery",
};
const MODE_ORDER: AssessmentMode[] = [
  "EXISTING_SYSTEM",
  "MODERNIZATION",
  "AUDIT",
  "PRE_IMPLEMENTATION",
  "GREENFIELD",
];

type FieldErrors = Partial<
  Record<"engagementId" | "assessmentTypeId" | "mode" | "activeDomains", string[]>
>;

export function AssessmentSetupForm({ engagementId }: { engagementId: string }) {
  const router = useRouter();
  const utils = trpc.useUtils();

  const typesQuery = trpc.assessment.listAssessmentTypes.useQuery();

  const [typeId, setTypeId] = useState<string>("");
  const [mode, setMode] = useState<AssessmentMode>("EXISTING_SYSTEM");
  const [domains, setDomains] = useState<Set<string>>(new Set());
  const [initialized, setInitialized] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  // On first successful load, seed state from the first type's defaults.
  // Subsequent type-dropdown changes are handled in the onChange below so
  // we don't fight with user edits on every React Query refetch.
  useEffect(() => {
    if (initialized) return;
    const list = typesQuery.data;
    if (!list || list.length === 0) return;
    const first = list[0];
    setTypeId(first.id);
    setMode(first.defaultMode as AssessmentMode);
    setDomains(new Set(first.defaultDomains));
    setInitialized(true);
  }, [typesQuery.data, initialized]);

  // Union of known domain keys across every seeded type, so the checkbox
  // list stays stable no matter which type the user picks.
  const allDomains = useMemo(() => {
    if (!typesQuery.data) return [] as string[];
    const set = new Set<string>();
    for (const t of typesQuery.data) {
      for (const d of t.defaultDomains) set.add(d);
    }
    return Array.from(set).sort((a, b) =>
      prettyDomain(a).localeCompare(prettyDomain(b)),
    );
  }, [typesQuery.data]);

  const selectedType = typesQuery.data?.find((t) => t.id === typeId);

  const createMutation = trpc.assessment.create.useMutation({
    onSuccess: async (assessment) => {
      // Invalidate the parent engagement so the detail page shows the
      // freshly-created assessment tile when the user navigates back.
      await utils.engagement.getById.invalidate({ id: engagementId });
      // Continue into Phase 2 (project context) on the same URL.
      router.replace(
        `/engagements/${engagementId}/setup?assessmentId=${assessment.id}`,
      );
    },
    onError: (err) => {
      const zod = err.data?.zodError;
      if (zod?.fieldErrors) {
        setFieldErrors(zod.fieldErrors as FieldErrors);
        setFormError("Please fix the fields below.");
      } else {
        setFormError(err.message || "Couldn't create assessment");
      }
    },
  });

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFieldErrors({});
    setFormError(null);

    if (!typeId) {
      setFormError("Pick an assessment type to continue.");
      return;
    }
    if (domains.size === 0) {
      setFieldErrors({ activeDomains: ["Select at least one domain."] });
      setFormError("Please fix the fields below.");
      return;
    }

    createMutation.mutate({
      engagementId,
      assessmentTypeId: typeId,
      mode,
      activeDomains: Array.from(domains),
    });
  }

  function handleTypeChange(nextId: string) {
    const t = typesQuery.data?.find((x) => x.id === nextId);
    setTypeId(nextId);
    if (t) {
      // Reset dependent fields to the new type's defaults. Users can still
      // adjust after the switch — this just gives them a sensible baseline.
      setMode(t.defaultMode as AssessmentMode);
      setDomains(new Set(t.defaultDomains));
    }
  }

  function toggleDomain(key: string) {
    setDomains((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (typesQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (typesQuery.error) {
    return (
      <p
        role="alert"
        className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        Couldn&apos;t load assessment types: {typesQuery.error.message}
      </p>
    );
  }

  const types = typesQuery.data ?? [];
  if (types.length === 0) {
    return (
      <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        No assessment types are configured yet. Ask an admin to seed or create
        one before starting a new assessment.
      </p>
    );
  }

  const submitting = createMutation.isPending;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <Label htmlFor="assessmentType">Assessment type</Label>
        <select
          id="assessmentType"
          className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={typeId}
          onChange={(e) => handleTypeChange(e.target.value)}
          disabled={submitting}
        >
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        {selectedType ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {selectedType.description}
          </p>
        ) : null}
        {fieldErrors.assessmentTypeId?.[0] ? (
          <p className="mt-1 text-xs text-destructive">
            {fieldErrors.assessmentTypeId[0]}
          </p>
        ) : null}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Assessment mode</legend>
        <p className="text-xs text-muted-foreground">
          Pre-filled from the selected type; override if this engagement is a
          different kind of exercise.
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {MODE_ORDER.map((m) => (
            <label
              key={m}
              className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm ${
                mode === m
                  ? "border-primary bg-primary/5"
                  : "border-input hover:bg-muted/40"
              }`}
            >
              <input
                type="radio"
                name="mode"
                value={m}
                className="mt-0.5"
                checked={mode === m}
                onChange={() => setMode(m)}
                disabled={submitting}
              />
              <span>{MODE_LABELS[m]}</span>
            </label>
          ))}
        </div>
        {fieldErrors.mode?.[0] ? (
          <p className="mt-1 text-xs text-destructive">{fieldErrors.mode[0]}</p>
        ) : null}
      </fieldset>

      <fieldset className="space-y-2">
        <div className="flex items-baseline justify-between">
          <legend className="text-sm font-medium">Active domains</legend>
          <div className="flex gap-3 text-xs">
            <button
              type="button"
              className="text-muted-foreground underline-offset-4 hover:underline"
              onClick={() => setDomains(new Set(allDomains))}
              disabled={submitting}
            >
              Select all
            </button>
            <button
              type="button"
              className="text-muted-foreground underline-offset-4 hover:underline"
              onClick={() =>
                selectedType
                  ? setDomains(new Set(selectedType.defaultDomains))
                  : setDomains(new Set())
              }
              disabled={submitting}
            >
              Reset to type defaults
            </button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Each active domain drives its own question set, scoring, and findings.
          Scope it down for focused reviews.
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {allDomains.map((d) => (
            <label
              key={d}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-input px-3 py-2 text-sm hover:bg-muted/40"
            >
              <input
                type="checkbox"
                checked={domains.has(d)}
                onChange={() => toggleDomain(d)}
                disabled={submitting}
              />
              <span>{prettyDomain(d)}</span>
            </label>
          ))}
        </div>
        {fieldErrors.activeDomains?.[0] ? (
          <p className="mt-1 text-xs text-destructive">
            {fieldErrors.activeDomains[0]}
          </p>
        ) : null}
      </fieldset>

      {formError ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {formError}
        </p>
      ) : null}

      <div className="flex gap-3 pt-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? "Creating…" : "Create assessment"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={submitting}
          onClick={() => router.push(`/engagements/${engagementId}`)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
