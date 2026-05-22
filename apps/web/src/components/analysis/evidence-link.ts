/**
 * Helper for cross-page linkage from Findings / Risks / Recommendations
 * into the Evidence Explorer (Phase 3 Week 7 polish).
 *
 * The Evidence Explorer page lives at `/engagements/[id]/evidence` and
 * already accepts an `assessmentId` search param. This helper adds
 * `q` (pre-filled search query) and `domain` (pre-filled filter) so a
 * reviewer can click "See evidence" next to any finding / risk / rec
 * and land on a focused query result.
 *
 * Kept as a pure string builder so it's usable from server components
 * too, and trivially unit-testable.
 */
export function buildEvidenceExplorerHref(opts: {
  engagementId: string;
  assessmentId: string;
  q?: string | null;
  domain?: string | null;
}): string {
  const { engagementId, assessmentId, q, domain } = opts;
  const params = new URLSearchParams();
  params.set("assessmentId", assessmentId);
  if (q && q.trim().length > 0) params.set("q", q.trim());
  if (domain && domain.trim().length > 0) params.set("domain", domain.trim());
  return `/engagements/${engagementId}/evidence?${params.toString()}`;
}
