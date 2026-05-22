import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/server/db";
import { engagementAccessFilter } from "@/server/authz";
import { QuestionList } from "@/components/questions/question-list";
import { AssessmentBackLink } from "@/components/assessment/back-link";

/**
 * Questions page. Same URL shape as /documents — the question table is
 * assessment-scoped, so we require `?assessmentId=` (auto-redirecting when
 * the engagement has exactly one assessment).
 */
export default async function QuestionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ assessmentId?: string | string[] }>;
}) {
  const { id: engagementId } = await params;
  const sp = await searchParams;
  const rawAssessmentId = Array.isArray(sp.assessmentId)
    ? sp.assessmentId[0]
    : sp.assessmentId;

  const session = await getServerSession(authOptions);
  if (!session?.user) {
    redirect(`/login?callbackUrl=/engagements/${engagementId}/questions`);
  }

  const engagement = await db.engagement.findFirst({
    where: { id: engagementId, ...engagementAccessFilter(session) },
    select: {
      id: true,
      name: true,
      assessments: {
        select: {
          id: true,
          mode: true,
          assessmentType: { select: { name: true } },
          projectContext: { select: { projectName: true } },
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!engagement) {
    return (
      <div className="space-y-3">
        <Link
          href="/engagements"
          className="text-xs font-medium text-muted-foreground underline-offset-4 hover:underline"
        >
          ← Back to engagements
        </Link>
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          Engagement not found, or you don&apos;t have access.
        </p>
      </div>
    );
  }

  if (engagement.assessments.length === 0) {
    redirect(`/engagements/${engagementId}/setup`);
  }
  if (!rawAssessmentId && engagement.assessments.length === 1) {
    redirect(
      `/engagements/${engagementId}/questions?assessmentId=${engagement.assessments[0].id}`,
    );
  }
  if (!rawAssessmentId) {
    return (
      <div className="space-y-4">
        <AssessmentBackLink
          engagementId={engagementId}
          engagementName={engagement.name}
        />
        <h1 className="text-2xl font-semibold tracking-tight">
          Pick an assessment
        </h1>
        <ul className="space-y-2">
          {engagement.assessments.map((a) => (
            <li key={a.id}>
              <Link
                href={`/engagements/${engagementId}/questions?assessmentId=${a.id}`}
                className="block rounded-md border p-3 text-sm transition-colors hover:bg-muted/40"
              >
                <div className="font-medium">{a.assessmentType.name}</div>
                <div className="text-xs text-muted-foreground">
                  {a.mode}
                  {a.projectContext?.projectName
                    ? ` · ${a.projectContext.projectName}`
                    : ""}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const match = engagement.assessments.find((a) => a.id === rawAssessmentId);
  if (!match) {
    redirect(`/engagements/${engagementId}/questions`);
  }

  return (
    <div className="space-y-4">
      <AssessmentBackLink
        engagementId={engagementId}
        assessmentId={match!.id}
        assessmentTypeName={match!.assessmentType.name}
        engagementName={engagement.name}
      />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Questions</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {match.assessmentType.name} · {match.mode}
          {match.projectContext?.projectName
            ? ` · ${match.projectContext.projectName}`
            : ""}
        </p>
      </div>
      <QuestionList assessmentId={rawAssessmentId} />
    </div>
  );
}
