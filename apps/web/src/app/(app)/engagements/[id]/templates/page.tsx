import { AssessmentBackLink } from "@/components/assessment/back-link";
import { TemplatesWorkspace } from "@/components/templates/templates-workspace";
import { db } from "@/server/db";

/**
 * Templates settings page for an engagement. Lets OWNER/ADMIN upload
 * customer-supplied .xlsx / .docx / .pptx templates, review the AI-
 * proposed bindings, and approve them for use by `runEstimation` /
 * `generateDeliverable`.
 *
 * Workspace defaults (engagementId = null) are surfaced read-only here
 * — admins manage them on `/admin/templates`. Power-users can still
 * override by uploading an engagement-scoped version with the same
 * name.
 */
export default async function EngagementTemplatesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: engagementId } = await params;
  const eng = await db.engagement.findUnique({
    where: { id: engagementId },
    select: { id: true, name: true },
  });
  if (!eng) {
    return (
      <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        Engagement not found, or you don&apos;t have access.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <AssessmentBackLink engagementId={engagementId} engagementName={eng.name} />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Templates</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload your own WBS workbook or deliverable shell. Once
          approved, the engine fills it with engine outputs whenever
          you run Team &amp; estimate or generate deliverables.
        </p>
      </div>
      <TemplatesWorkspace engagementId={engagementId} />
    </div>
  );
}
