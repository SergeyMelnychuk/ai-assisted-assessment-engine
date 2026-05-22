"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type BudgetSensitivity = "LOW" | "MEDIUM" | "HIGH" | "";

// Split a comma-separated user input into a clean string[]. Empty strings,
// whitespace-only entries, and dupes are dropped so the DB stays tidy.
function splitList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const v = part.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function joinList(values: string[] | null | undefined): string {
  return values?.join(", ") ?? "";
}

type FormState = {
  projectName: string;
  description: string;
  industry: string;
  cloudProviders: string;
  platforms: string;
  knownConstraints: string;
  businessGoals: string;
  expectedTimeline: string;
  budgetSensitivity: BudgetSensitivity;
  targetDeliveryModel: string;
  estimatedUsers: string;
  complianceRequirements: string;
  existingTeamSummary: string;
  isGreenfield: boolean;
};

const EMPTY_STATE: FormState = {
  projectName: "",
  description: "",
  industry: "",
  cloudProviders: "",
  platforms: "",
  knownConstraints: "",
  businessGoals: "",
  expectedTimeline: "",
  budgetSensitivity: "",
  targetDeliveryModel: "",
  estimatedUsers: "",
  complianceRequirements: "",
  existingTeamSummary: "",
  isGreenfield: false,
};

export function ProjectContextForm({
  assessmentId,
  engagementId,
}: {
  assessmentId: string;
  engagementId: string;
}) {
  const utils = trpc.useUtils();
  const assessmentQuery = trpc.assessment.getById.useQuery(
    { id: assessmentId },
    {
      // NOT_FOUND here is the authz-deny signal; retrying just delays the
      // error card.
      retry: (failureCount, err) =>
        err.data?.code !== "NOT_FOUND" && failureCount < 1,
    },
  );

  const [form, setForm] = useState<FormState>(EMPTY_STATE);
  const [hydrated, setHydrated] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Prefill from the persisted project context once — further refetches
  // shouldn't clobber in-flight edits.
  useEffect(() => {
    if (hydrated || !assessmentQuery.data) return;
    const ctx = assessmentQuery.data.projectContext;
    if (ctx) {
      setForm({
        projectName: ctx.projectName ?? "",
        description: ctx.description ?? "",
        industry: ctx.industry ?? "",
        cloudProviders: joinList(ctx.cloudProviders),
        platforms: joinList(ctx.platforms),
        knownConstraints: ctx.knownConstraints ?? "",
        businessGoals: ctx.businessGoals ?? "",
        expectedTimeline: ctx.expectedTimeline ?? "",
        budgetSensitivity: (ctx.budgetSensitivity ?? "") as BudgetSensitivity,
        targetDeliveryModel: ctx.targetDeliveryModel ?? "",
        estimatedUsers: ctx.estimatedUsers ?? "",
        complianceRequirements: joinList(ctx.complianceRequirements),
        existingTeamSummary: ctx.existingTeamSummary ?? "",
        isGreenfield: ctx.isGreenfield ?? false,
      });
    } else {
      // If the project context doesn't exist yet, seed a couple of sensible
      // defaults from the assessment so the user isn't staring at an empty
      // form.
      setForm((prev) => ({
        ...prev,
        isGreenfield: assessmentQuery.data?.mode === "GREENFIELD",
      }));
    }
    setHydrated(true);
  }, [assessmentQuery.data, hydrated]);

  const updateMutation = trpc.assessment.updateProjectContext.useMutation({
    onSuccess: async () => {
      setSaved(true);
      await utils.assessment.getById.invalidate({ id: assessmentId });
      // Transient confirmation — clears so the user can save again.
      setTimeout(() => setSaved(false), 2500);
    },
    onError: (err) => {
      setFormError(err.message || "Couldn't save project context");
    },
  });

  function handleField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (saved) setSaved(false);
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);

    // Only send fields the user actually filled in. The procedure accepts
    // optional fields; sending empty strings would store "" and muddy
    // downstream AI prompts.
    const payload = {
      assessmentId,
      projectName: form.projectName.trim() || undefined,
      description: form.description.trim() || undefined,
      industry: form.industry.trim() || undefined,
      cloudProviders:
        splitList(form.cloudProviders).length > 0
          ? splitList(form.cloudProviders)
          : undefined,
      platforms:
        splitList(form.platforms).length > 0
          ? splitList(form.platforms)
          : undefined,
      knownConstraints: form.knownConstraints.trim() || undefined,
      businessGoals: form.businessGoals.trim() || undefined,
      expectedTimeline: form.expectedTimeline.trim() || undefined,
      budgetSensitivity: form.budgetSensitivity || undefined,
      targetDeliveryModel: form.targetDeliveryModel.trim() || undefined,
      estimatedUsers: form.estimatedUsers.trim() || undefined,
      complianceRequirements:
        splitList(form.complianceRequirements).length > 0
          ? splitList(form.complianceRequirements)
          : undefined,
      existingTeamSummary: form.existingTeamSummary.trim() || undefined,
      isGreenfield: form.isGreenfield,
    };

    updateMutation.mutate(payload);
  }

  if (assessmentQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (assessmentQuery.error) {
    const isNotFound = assessmentQuery.error.data?.code === "NOT_FOUND";
    return (
      <Card className="border-destructive/40 bg-destructive/5">
        <CardHeader>
          <CardTitle className="text-destructive">
            {isNotFound
              ? "Assessment not found"
              : "Couldn't load assessment"}
          </CardTitle>
          <CardDescription className="text-destructive/80">
            {isNotFound
              ? "It may have been deleted, or you don't have access."
              : assessmentQuery.error.message}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link
            href={`/engagements/${engagementId}`}
            className="text-sm font-medium underline underline-offset-4"
          >
            Back to engagement
          </Link>
        </CardContent>
      </Card>
    );
  }

  const assessment = assessmentQuery.data;
  if (!assessment) return null;

  const submitting = updateMutation.isPending;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Assessment configuration</CardTitle>
          <CardDescription>
            {assessment.assessmentType.name} · {assessment.mode} ·{" "}
            {assessment.activeDomains.length} domain
            {assessment.activeDomains.length === 1 ? "" : "s"} active
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {assessment.activeDomains.map((d) => (
              <span
                key={d}
                className="inline-flex items-center rounded-full border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
              >
                {d}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>

      <form onSubmit={handleSubmit} className="space-y-8">
        <section className="space-y-4">
          <header>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Project essentials
            </h2>
          </header>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label htmlFor="projectName">Project name</Label>
              <Input
                id="projectName"
                className="mt-1"
                maxLength={200}
                placeholder="e.g. Customer 360 Platform"
                value={form.projectName}
                onChange={(e) => handleField("projectName", e.target.value)}
                disabled={submitting}
              />
            </div>
            <div>
              <Label htmlFor="industry">Industry</Label>
              <Input
                id="industry"
                className="mt-1"
                maxLength={120}
                placeholder="e.g. Healthcare, Retail, FinTech"
                value={form.industry}
                onChange={(e) => handleField("industry", e.target.value)}
                disabled={submitting}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="description">Project description</Label>
            <Textarea
              id="description"
              className="mt-1 min-h-[96px]"
              maxLength={4000}
              placeholder="What is being built (or assessed), and for whom?"
              value={form.description}
              onChange={(e) => handleField("description", e.target.value)}
              disabled={submitting}
            />
          </div>
        </section>

        <section className="space-y-4">
          <header>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Goals &amp; constraints
            </h2>
          </header>
          <div>
            <Label htmlFor="businessGoals">Business goals</Label>
            <Textarea
              id="businessGoals"
              className="mt-1 min-h-[96px]"
              maxLength={4000}
              placeholder="What outcomes does this engagement need to move?"
              value={form.businessGoals}
              onChange={(e) => handleField("businessGoals", e.target.value)}
              disabled={submitting}
            />
          </div>
          <div>
            <Label htmlFor="knownConstraints">Known constraints</Label>
            <Textarea
              id="knownConstraints"
              className="mt-1 min-h-[96px]"
              maxLength={4000}
              placeholder="Budget caps, fixed deadlines, tech mandates, org realities…"
              value={form.knownConstraints}
              onChange={(e) => handleField("knownConstraints", e.target.value)}
              disabled={submitting}
            />
          </div>
          <div>
            <Label htmlFor="complianceRequirements">
              Compliance requirements{" "}
              <span className="text-muted-foreground">(comma-separated)</span>
            </Label>
            <Input
              id="complianceRequirements"
              className="mt-1"
              placeholder="e.g. HIPAA, SOC 2, GDPR"
              value={form.complianceRequirements}
              onChange={(e) =>
                handleField("complianceRequirements", e.target.value)
              }
              disabled={submitting}
            />
          </div>
        </section>

        <section className="space-y-4">
          <header>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Delivery &amp; scope
            </h2>
          </header>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label htmlFor="expectedTimeline">Expected timeline</Label>
              <Input
                id="expectedTimeline"
                className="mt-1"
                maxLength={200}
                placeholder="e.g. MVP in 6 months"
                value={form.expectedTimeline}
                onChange={(e) =>
                  handleField("expectedTimeline", e.target.value)
                }
                disabled={submitting}
              />
            </div>
            <div>
              <Label htmlFor="targetDeliveryModel">Target delivery model</Label>
              <Input
                id="targetDeliveryModel"
                className="mt-1"
                maxLength={200}
                placeholder="e.g. Dual-shore Scrum, Kanban, internal platform team"
                value={form.targetDeliveryModel}
                onChange={(e) =>
                  handleField("targetDeliveryModel", e.target.value)
                }
                disabled={submitting}
              />
            </div>
            <div>
              <Label htmlFor="estimatedUsers">Estimated users / scale</Label>
              <Input
                id="estimatedUsers"
                className="mt-1"
                maxLength={200}
                placeholder="e.g. 50k monthly active users"
                value={form.estimatedUsers}
                onChange={(e) => handleField("estimatedUsers", e.target.value)}
                disabled={submitting}
              />
            </div>
            <div>
              <Label htmlFor="budgetSensitivity">Budget sensitivity</Label>
              <select
                id="budgetSensitivity"
                className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                value={form.budgetSensitivity}
                onChange={(e) =>
                  handleField(
                    "budgetSensitivity",
                    e.target.value as BudgetSensitivity,
                  )
                }
                disabled={submitting}
              >
                <option value="">— not specified —</option>
                <option value="LOW">Low — open to investment</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High — tight budget</option>
              </select>
            </div>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.isGreenfield}
              onChange={(e) => handleField("isGreenfield", e.target.checked)}
              disabled={submitting}
            />
            <span>This is a greenfield build (no existing system)</span>
          </label>
        </section>

        <section className="space-y-4">
          <header>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Technology landscape
            </h2>
          </header>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label htmlFor="cloudProviders">
                Cloud providers{" "}
                <span className="text-muted-foreground">(comma-separated)</span>
              </Label>
              <Input
                id="cloudProviders"
                className="mt-1"
                placeholder="e.g. AWS, Azure"
                value={form.cloudProviders}
                onChange={(e) => handleField("cloudProviders", e.target.value)}
                disabled={submitting}
              />
            </div>
            <div>
              <Label htmlFor="platforms">
                Platforms / stack{" "}
                <span className="text-muted-foreground">(comma-separated)</span>
              </Label>
              <Input
                id="platforms"
                className="mt-1"
                placeholder="e.g. Kubernetes, Snowflake, Node.js"
                value={form.platforms}
                onChange={(e) => handleField("platforms", e.target.value)}
                disabled={submitting}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="existingTeamSummary">Existing team summary</Label>
            <Textarea
              id="existingTeamSummary"
              className="mt-1 min-h-[96px]"
              maxLength={4000}
              placeholder="Shape of the current team: roles, seniority, gaps, vendors…"
              value={form.existingTeamSummary}
              onChange={(e) =>
                handleField("existingTeamSummary", e.target.value)
              }
              disabled={submitting}
            />
          </div>
        </section>

        {formError ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {formError}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : "Save project context"}
          </Button>
          <Link
            href={`/engagements/${engagementId}/documents?assessmentId=${assessmentId}`}
            className="text-sm font-medium underline-offset-4 hover:underline"
          >
            Upload documents →
          </Link>
          <Link
            href={`/engagements/${engagementId}`}
            className="text-sm font-medium text-muted-foreground underline-offset-4 hover:underline"
          >
            Back to engagement
          </Link>
          {saved ? (
            <span
              role="status"
              className="text-xs font-medium text-green-700 dark:text-green-400"
            >
              Saved.
            </span>
          ) : null}
        </div>
      </form>
    </div>
  );
}
