import { redirect } from "next/navigation";
import { getServerSession, type Session } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/server/db";
import { engagementAccessFilter } from "@/server/authz";

type Resolved = {
  session: Session;
  engagement: {
    id: string;
    name: string;
    assessments: Array<{
      id: string;
      mode: string;
      assessmentType: { name: string };
      projectContext: { projectName: string | null } | null;
    }>;
  };
  /** Resolved assessment to operate on; null when the caller must render a picker. */
  match:
    | {
        id: string;
        mode: string;
        assessmentType: { name: string };
        projectContext: { projectName: string | null } | null;
      }
    | null;
};

type ResolveArgs = {
  engagementId: string;
  rawAssessmentId: string | undefined;
  /** Sub-path we're on (e.g. "findings", "documents") so auto-redirects keep the user on the same tab. */
  subpath: string;
};

/**
 * Shared server-side resolver for `/engagements/[id]/<tab>?assessmentId=`
 * pages. Handles the same branching the Documents and Questions pages
 * already do: no-session → login, no-engagement → back, zero-assessment →
 * setup, single-assessment → auto-pin the `assessmentId=` param, bad
 * `assessmentId=` → drop it and show the picker.
 *
 * Returns either a resolved assessment or `match: null` signalling the
 * caller should render its "pick an assessment" fallback. `redirect()`
 * calls here propagate out through Next's exception-based redirect.
 */
export async function resolveAssessmentPage(
  args: ResolveArgs,
): Promise<Resolved> {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    redirect(
      `/login?callbackUrl=/engagements/${args.engagementId}/${args.subpath}`,
    );
  }

  const engagement = await db.engagement.findFirst({
    where: { id: args.engagementId, ...engagementAccessFilter(session) },
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
    // We throw by returning a sentinel; the caller renders a "not found"
    // card. Keeping it an exception would require a custom error boundary
    // on every page.
    return {
      session,
      engagement: { id: args.engagementId, name: "", assessments: [] },
      match: null,
    };
  }

  if (engagement.assessments.length === 0) {
    redirect(`/engagements/${args.engagementId}/setup`);
  }

  if (!args.rawAssessmentId && engagement.assessments.length === 1) {
    redirect(
      `/engagements/${args.engagementId}/${args.subpath}?assessmentId=${engagement.assessments[0].id}`,
    );
  }

  if (!args.rawAssessmentId) {
    return { session, engagement, match: null };
  }

  const match = engagement.assessments.find(
    (a) => a.id === args.rawAssessmentId,
  );
  if (!match) {
    redirect(`/engagements/${args.engagementId}/${args.subpath}`);
  }

  return { session, engagement, match };
}
