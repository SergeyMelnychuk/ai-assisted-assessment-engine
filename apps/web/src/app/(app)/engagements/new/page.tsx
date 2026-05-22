import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { CreateEngagementForm } from "@/components/engagement/create-engagement-form";

export default function NewEngagementPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Link
          href="/engagements"
          className="text-xs font-medium text-muted-foreground underline-offset-4 hover:underline"
        >
          ← Back to engagements
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          New engagement
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Create a container for one or more assessments. You can add
          assessments of different types later.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <CreateEngagementForm />
        </CardContent>
      </Card>
    </div>
  );
}
