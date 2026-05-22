import Link from "next/link";

/**
 * Back-link rendered at the top of every per-tab page under
 * `/engagements/[id]/<tab>`.
 *
 * Two modes:
 *   - **Assessment context** — when the page resolved a specific
 *     assessment (the common case after auto-pin), the link goes to
 *     the assessment landing page and uses the assessment type's
 *     name. So a Findings page open on a "Discovery" assessment
 *     shows "← Back to Discovery". Matches what the user expects:
 *     they came from the assessment, not the engagement.
 *   - **Engagement fallback** — when there's no assessment in
 *     context (e.g. the picker view), link back to the engagement.
 *
 * Lives in `components/assessment/` because it's only used on
 * assessment-tab pages.
 */
export function AssessmentBackLink({
  engagementId,
  assessmentId,
  assessmentTypeName,
  engagementName,
}: {
  engagementId: string;
  assessmentId?: string | null;
  /**
   * Display name from `Assessment.assessmentType.name` (e.g.
   * "Discovery", "Existing System", "Greenfield Architecture").
   */
  assessmentTypeName?: string | null;
  /** Used in the engagement-fallback label only. */
  engagementName?: string | null;
}) {
  const hasAssessment = !!assessmentId && !!assessmentTypeName;
  const href = hasAssessment
    ? `/engagements/${engagementId}/assessments/${assessmentId}`
    : `/engagements/${engagementId}`;
  const label = hasAssessment
    ? `← Back to ${assessmentTypeName}`
    : engagementName
      ? `← Back to ${engagementName}`
      : "← Back to engagement";
  return (
    <Link
      href={href}
      className="text-xs font-medium text-muted-foreground underline-offset-4 hover:underline"
    >
      {label}
    </Link>
  );
}
