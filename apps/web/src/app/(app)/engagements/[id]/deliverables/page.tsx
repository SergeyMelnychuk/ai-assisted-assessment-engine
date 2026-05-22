import Link from "next/link";
import { AssessmentBackLink } from "@/components/assessment/back-link";
import { resolveAssessmentPage } from "@/lib/resolve-assessment-page";
import { DeliverablesWorkspace } from "@/components/assessment/deliverables-workspace";

export default async function DeliverablesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ assessmentId?: string | string[] }>;
}) {
  const { id: engagementId } = await params;
  const sp = await searchParams;
  const raw = Array.isArray(sp.assessmentId) ? sp.assessmentId[0] : sp.assessmentId;
  const resolved = await resolveAssessmentPage({
    engagementId,
    rawAssessmentId: raw,
    subpath: "deliverables",
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
                href={`/engagements/${engagementId}/deliverables?assessmentId=${a.id}`}
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
    <div className="space-y-6">
      <div>
        <AssessmentBackLink engagementId={engagementId} assessmentId={resolved.match.id} assessmentTypeName={resolved.match.assessmentType.name} engagementName={resolved.engagement.name} />
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Deliverables</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {resolved.match.assessmentType.name} · {resolved.match.mode}
          {resolved.match.projectContext?.projectName
            ? ` · ${resolved.match.projectContext.projectName}`
            : ""}
        </p>
      </div>
      <DeliverablesWorkspace
        assessmentId={resolved.match.id}
        engagementId={engagementId}
      />
    </div>
  );
}
