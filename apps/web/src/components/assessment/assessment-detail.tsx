"use client";

import Link from "next/link";
import { trpc } from "@/lib/trpc";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentCredentialPrompt } from "./agent-credential-prompt";
import { AgentRunsPanel } from "./agent-runs-panel";
import { AgentWorkflowDiagram } from "./agent-workflow-diagram";

/**
 * Lifecycle stages — kept in sync with the `AssessmentStage` Prisma enum
 * and the zod guard on `assessment.updateStatus`. Source-of-truth lives
 * in the schema; we copy the literals here so the dropdown can render
 * them without round-tripping the server.
 */
const ASSESSMENT_STATUS_VALUES = [
  "SETUP",
  "INTAKE",
  "QUESTIONING",
  "ANALYSIS",
  "DRAFTING",
  "REVIEW",
  "COMPLETED",
] as const;
type AssessmentStatus = (typeof ASSESSMENT_STATUS_VALUES)[number];

function statusToneClass(status: string): string {
  // Mirrors the engagement status palette: hue lives on border + bg,
  // text stays on `text-foreground` for contrast on tinted chips.
  switch (status) {
    case "SETUP":
    case "INTAKE":
      return "border-border bg-muted text-foreground";
    case "QUESTIONING":
    case "ANALYSIS":
      return "border-amber-500/40 bg-amber-500/10 text-foreground";
    case "DRAFTING":
    case "REVIEW":
      return "border-blue-500/40 bg-blue-500/10 text-foreground";
    case "COMPLETED":
      return "border-green-500/40 bg-green-500/10 text-foreground";
    default:
      return "border-border bg-muted text-foreground";
  }
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusToneClass(status)}`}
      aria-label={`Status: ${status}`}
    >
      {status}
    </span>
  );
}

/**
 * Editable lifecycle pill. OWNER/ADMIN sees a styled `<select>`; everyone
 * else gets the read-only badge. We avoid optimistic updates — status
 * transitions are rare, write an audit row server-side, and may be
 * rejected (e.g. archived row) so it's better to render the confirmed
 * value than race the mutation.
 */
function StatusSelect({
  assessmentId,
  engagementId,
  status,
}: {
  assessmentId: string;
  engagementId: string;
  status: string;
}) {
  const utils = trpc.useUtils();
  const mutation = trpc.assessment.updateStatus.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.assessment.getById.invalidate({ id: assessmentId }),
        utils.engagement.getById.invalidate({ id: engagementId }),
        utils.engagement.getById.invalidate({
          id: engagementId,
          includeArchived: true,
        }),
      ]);
    },
  });
  const pending = mutation.isPending;
  return (
    <span className="inline-flex items-center gap-2">
      <label className="sr-only" htmlFor={`assessment-status-${assessmentId}`}>
        Assessment status
      </label>
      <select
        id={`assessment-status-${assessmentId}`}
        value={status}
        disabled={pending}
        onChange={(e) =>
          mutation.mutate({
            id: assessmentId,
            status: e.target.value as AssessmentStatus,
          })
        }
        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 ${statusToneClass(status)}`}
      >
        {ASSESSMENT_STATUS_VALUES.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
      {mutation.error ? (
        <span className="text-xs text-destructive" role="alert">
          {mutation.error.message}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Per-assessment section nav. Each link points at an existing
 * engagement-level route with `?assessmentId=X` pinned, so the
 * destination skips its picker page and renders straight into the
 * selected assessment. Keeping this list in one place makes
 * add/remove/reorder a single-file edit.
 */
const ASSESSMENT_TABS: readonly { slug: string; label: string }[] = [
  { slug: "setup", label: "Setup" },
  { slug: "documents", label: "Documents" },
  { slug: "questions", label: "Questions" },
  { slug: "findings", label: "Findings" },
  { slug: "risks", label: "Risks" },
  { slug: "recommendations", label: "Recommendations" },
  { slug: "scoring", label: "Scoring" },
  { slug: "team-estimate", label: "Team & estimate" },
  { slug: "deliverables", label: "Deliverables" },
  { slug: "evidence", label: "Evidence" },
  { slug: "export", label: "Export" },
];

/**
 * Assessment landing page. Renders the heading + section nav and a
 * summary card of what's currently in the assessment (project context
 * snapshot, counts of evidence / findings / risks). The detailed
 * editing surfaces live on the per-section sub-routes; this page is
 * the index that ties them together.
 *
 * Archived assessments are read-locked at the tRPC layer
 * (`assertAssessmentAccess` filters `archivedAt: null`), so a NOT_FOUND
 * here means either "the row is archived" or "you don't have access" —
 * we render a single banner that doesn't distinguish between the two,
 * matching the rest of the app's existence-opacity rule.
 */
export function AssessmentDetail({
  engagementId,
  assessmentId,
}: {
  engagementId: string;
  assessmentId: string;
}) {
  const { data, isLoading, error } = trpc.assessment.getById.useQuery(
    { id: assessmentId },
    {
      // Don't retry 404s — that's the read-lock / authz signal.
      retry: (failureCount, err) =>
        err.data?.code !== "NOT_FOUND" && failureCount < 1,
    },
  );
  // Probe whether the caller can mutate this assessment so the heading
  // renders the editable status pill vs the read-only badge. Skipped
  // entirely when the row failed to load — there's nothing to gate.
  const canMutateQuery = trpc.assessment.canMutate.useQuery(
    { id: assessmentId },
    { enabled: !!data, retry: false },
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="mt-6 h-32 w-full" />
      </div>
    );
  }

  if (error) {
    const isNotFound = error.data?.code === "NOT_FOUND";
    return (
      <Card className="border-destructive/40 bg-destructive/5">
        <CardHeader>
          <CardTitle className="text-destructive">
            {isNotFound ? "Assessment not available" : "Couldn't load assessment"}
          </CardTitle>
          <CardDescription className="text-destructive/80">
            {isNotFound
              ? "It may have been archived, deleted, or you don't have access. Restore it from the engagement page if it was archived."
              : error.message}
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

  if (!data) return null;

  const projectName = data.projectContext?.projectName ?? null;
  const canMutate = canMutateQuery.data ?? false;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {data.assessmentType.name}
        </h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{data.mode}</span>
          <span aria-hidden="true">·</span>
          {canMutate ? (
            <StatusSelect
              assessmentId={data.id}
              engagementId={engagementId}
              status={data.status}
            />
          ) : (
            <StatusBadge status={data.status} />
          )}
          {projectName ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{projectName}</span>
            </>
          ) : null}
        </div>
      </div>

      <AgentCredentialPrompt assessmentId={data.id} />

      <nav
        aria-label="Assessment sections"
        className="flex flex-wrap gap-1.5"
      >
        {ASSESSMENT_TABS.map((tab) => (
          <Link
            key={tab.slug}
            href={`/engagements/${engagementId}/${tab.slug}?assessmentId=${data.id}`}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Project context</CardTitle>
            <CardDescription>
              {data.projectContext
                ? "Captured during setup; drives prompt + retrieval."
                : "Not yet filled in. Open Setup to record project context."}
            </CardDescription>
          </CardHeader>
          {data.projectContext ? (
            <CardContent className="space-y-2 text-sm">
              {data.projectContext.industry ? (
                <p>
                  <span className="text-muted-foreground">Industry: </span>
                  {data.projectContext.industry}
                </p>
              ) : null}
              {data.projectContext.cloudProviders.length > 0 ? (
                <p>
                  <span className="text-muted-foreground">Cloud: </span>
                  {data.projectContext.cloudProviders.join(", ")}
                </p>
              ) : null}
              {data.projectContext.platforms.length > 0 ? (
                <p>
                  <span className="text-muted-foreground">Platforms: </span>
                  {data.projectContext.platforms.join(", ")}
                </p>
              ) : null}
              {data.projectContext.complianceRequirements.length > 0 ? (
                <p>
                  <span className="text-muted-foreground">Compliance: </span>
                  {data.projectContext.complianceRequirements.join(", ")}
                </p>
              ) : null}
              {data.projectContext.businessGoals ? (
                <p className="line-clamp-3 text-muted-foreground">
                  {data.projectContext.businessGoals}
                </p>
              ) : null}
            </CardContent>
          ) : null}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Status at a glance</CardTitle>
            <CardDescription>
              Counts roll up the work done so far. Open the relevant tab
              for detail.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <Stat label="Documents" value={data.documents.length} />
              <Stat label="Domain scores" value={data.domainScores.length} />
              <Stat label="Findings" value={data.findings.length} />
              <Stat label="Risks" value={data.risks.length} />
              <Stat
                label="Recommendations"
                value={data.recommendations.length}
              />
              <Stat label="Deliverables" value={data.deliverables.length} />
            </dl>
          </CardContent>
        </Card>
      </div>

      <AgentRunsPanel assessmentId={data.id} canMutate={canMutate} />
      <AgentWorkflowDiagram
        engagementId={engagementId}
        assessmentId={data.id}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-lg font-semibold">{value}</dd>
    </div>
  );
}
