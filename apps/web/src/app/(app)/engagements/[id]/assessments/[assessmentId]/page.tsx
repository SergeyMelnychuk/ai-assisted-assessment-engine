import Link from "next/link";
import { AssessmentDetail } from "@/components/assessment/assessment-detail";

/**
 * Per-assessment landing page. Hosts the section nav (Setup, Documents,
 * Questions, Findings, …) and a summary of the selected assessment so
 * the user has a stable home for one assessment in an engagement that
 * may carry several. Reachable from the engagement page by clicking
 * any active assessment row; archived rows don't link here because the
 * assessment-access guard treats them as 404 until restored.
 */
export default async function AssessmentDetailPage({
  params,
}: {
  params: Promise<{ id: string; assessmentId: string }>;
}) {
  const { id: engagementId, assessmentId } = await params;

  return (
    <div className="space-y-4">
      <Link
        href={`/engagements/${engagementId}`}
        className="text-xs font-medium text-muted-foreground underline-offset-4 hover:underline"
      >
        ← Back to engagement
      </Link>
      <AssessmentDetail
        engagementId={engagementId}
        assessmentId={assessmentId}
      />
    </div>
  );
}
