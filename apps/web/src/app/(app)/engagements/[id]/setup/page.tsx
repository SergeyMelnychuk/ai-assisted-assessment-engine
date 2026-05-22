import { AssessmentSetupForm } from "@/components/assessment/assessment-setup-form";
import { ProjectContextForm } from "@/components/assessment/project-context-form";
import { AssessmentBackLink } from "@/components/assessment/back-link";
import { db } from "@/server/db";

// Two-phase setup flow driven by a URL param:
//   /engagements/[id]/setup                    → Phase 1 (create assessment)
//   /engagements/[id]/setup?assessmentId=...   → Phase 2 (project context)
//
// Using a search param (vs. a wizard step stored in component state) keeps
// the flow deep-linkable, survives reloads, and lets the browser back
// button behave intuitively between phases.
export default async function AssessmentSetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ assessmentId?: string | string[] }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const rawAssessmentId = Array.isArray(sp.assessmentId)
    ? sp.assessmentId[0]
    : sp.assessmentId;
  // Guard against malformed input — we only route to the second phase if
  // the param shape looks plausible. The server-side tRPC call still
  // validates the cuid and enforces authz.
  const assessmentId =
    rawAssessmentId && rawAssessmentId.length > 0 ? rawAssessmentId : null;

  // In Phase 2 we want the back link to point at the assessment landing
  // page (and use the assessment type's name as the label). In Phase 1
  // there's no assessment yet, so we fall back to the engagement.
  let assessmentTypeName: string | null = null;
  if (assessmentId) {
    const a = await db.assessment.findUnique({
      where: { id: assessmentId },
      select: { assessmentType: { select: { name: true } } },
    });
    assessmentTypeName = a?.assessmentType.name ?? null;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <AssessmentBackLink
          engagementId={id}
          assessmentId={assessmentId}
          assessmentTypeName={assessmentTypeName}
        />
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {assessmentId ? "Project context" : "New assessment"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {assessmentId
            ? "Capture the background the AI needs to ask sharper questions, draft better findings, and scope the team."
            : "Pick the assessment type, mode, and domains in scope. You'll add project context next."}
        </p>
      </div>

      {assessmentId ? (
        <ProjectContextForm assessmentId={assessmentId} engagementId={id} />
      ) : (
        <AssessmentSetupForm engagementId={id} />
      )}
    </div>
  );
}
