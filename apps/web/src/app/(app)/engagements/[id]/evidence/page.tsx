import Link from "next/link";
import { AssessmentBackLink } from "@/components/assessment/back-link";
import { resolveAssessmentPage } from "@/lib/resolve-assessment-page";
import { EvidenceExplorer } from "@/components/evidence/evidence-explorer";

/**
 * Evidence Explorer page (Phase 3 Week 7, ADR-0011).
 *
 * Free-text semantic search + domain sidebar + clustered results list.
 * Membership-gated via `resolveAssessmentPage` (itself built on
 * `engagementAccessFilter`) — non-members get a NOT_FOUND-shaped empty
 * state, not a FORBIDDEN error (consistent with the rest of the app).
 */
export default async function EvidenceExplorerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    assessmentId?: string | string[];
    q?: string | string[];
    domain?: string | string[];
  }>;
}) {
  const { id: engagementId } = await params;
  const sp = await searchParams;
  const raw = Array.isArray(sp.assessmentId) ? sp.assessmentId[0] : sp.assessmentId;
  const initialQuery = Array.isArray(sp.q) ? sp.q[0] : sp.q;
  const initialDomain = Array.isArray(sp.domain) ? sp.domain[0] : sp.domain;
  const resolved = await resolveAssessmentPage({
    engagementId,
    rawAssessmentId: raw,
    subpath: "evidence",
  });

  if (!resolved.engagement.id) {
    return (
      <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        Engagement not found, or you don&apos;t have access.
      </p>
    );
  }

  if (!resolved.match) {
    return (
      <div className="space-y-4">
        <AssessmentBackLink engagementId={engagementId} engagementName={resolved.engagement.name} />
        <h1 className="text-2xl font-semibold tracking-tight">Pick an assessment</h1>
        <ul className="space-y-2">
          {resolved.engagement.assessments.map((a) => (
            <li key={a.id}>
              <Link
                href={`/engagements/${engagementId}/evidence?assessmentId=${a.id}`}
                className="block rounded-md border p-3 text-sm transition-colors hover:bg-muted/40"
              >
                {a.assessmentType.name} — {a.mode}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <AssessmentBackLink engagementId={engagementId} assessmentId={resolved.match.id} assessmentTypeName={resolved.match.assessmentType.name} engagementName={resolved.engagement.name} />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Evidence Explorer</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Search across all ingested evidence for this assessment.
          Near-duplicate chunks are merged into a single row; click
          any result to open it in context.
        </p>
      </div>
      <EvidenceExplorer
        assessmentId={resolved.match.id}
        initialQuery={initialQuery}
        initialDomain={initialDomain}
      />
    </div>
  );
}
