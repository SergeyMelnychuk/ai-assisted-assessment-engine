import Link from "next/link";
import { EngagementDetail } from "@/components/engagement/engagement-detail";

// Next 15 delivers dynamic params as a Promise — `await` is required.
export default async function EngagementDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <div className="space-y-4">
      <Link
        href="/engagements"
        className="text-xs font-medium text-muted-foreground underline-offset-4 hover:underline"
      >
        ← Back to engagements
      </Link>
      <EngagementDetail id={id} />
    </div>
  );
}
