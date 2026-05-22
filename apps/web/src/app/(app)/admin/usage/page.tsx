import { UsageFullView } from "@/components/admin/usage-full-view";

/**
 * Admin AI-usage dashboard — provider/model rollup.
 *
 * Standalone route at `/admin/usage`. The same UI is also rendered
 * inline inside `/admin/settings?tab=usage&view=full` via the shared
 * `<UsageFullView />` client component. This page forwards URL
 * `searchParams` as the component's initial filter values so deep
 * links (e.g. from audit-log triage) keep pre-populating the form.
 *
 * The admin layout gates on `role === ADMIN`; the tRPC procedure
 * driving this view (`cost.modelRollup`) additionally asserts role,
 * matching the defence-in-depth pattern used across this router.
 */

export const dynamic = "force-dynamic";

interface SearchParams {
  from?: string | string[];
  to?: string | string[];
  model?: string | string[];
  callType?: string | string[];
  provider?: string | string[];
  engagement?: string | string[];
}

function firstString(
  v: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export default async function AdminUsagePage({
  searchParams,
}: {
  // Next 15 hands searchParams in as a Promise — await once and pass
  // the normalized shape into the client view.
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          AI usage & costs
        </h1>
      </div>
      <UsageFullView
        initialFilters={{
          from: firstString(sp.from),
          to: firstString(sp.to),
          model: firstString(sp.model),
          callType: firstString(sp.callType),
          provider: firstString(sp.provider),
          engagement: firstString(sp.engagement),
        }}
      />
    </div>
  );
}
