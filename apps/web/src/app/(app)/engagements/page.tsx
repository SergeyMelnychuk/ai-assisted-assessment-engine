import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { EngagementList } from "@/components/engagement/engagement-list";

// Server component shell — the list itself is a client component so it can
// use the tRPC hook. Create + detail are real in Task 5; edit/archive will
// ship later once assessment state interactions are defined.
export default function EngagementsPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Engagements</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            All discovery, audit, and solution-shaping engagements you have
            access to.
          </p>
        </div>
        <Link href="/engagements/new" className={buttonVariants()}>
          New engagement
        </Link>
      </div>

      <EngagementList />
    </div>
  );
}
