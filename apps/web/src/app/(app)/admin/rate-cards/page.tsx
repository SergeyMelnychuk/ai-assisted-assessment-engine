import { RateCardsAdmin } from "@/components/admin/rate-cards-admin";

/**
 * Admin rate-card editor. Admin layout already gates on `role === ADMIN`
 * server-side; this page is a thin wrapper around the client-side CRUD UI.
 * All data/mutations flow through the `rateCard` tRPC router.
 */
export default function RateCardsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Rate Cards</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Roles, seniorities, hourly and daily rates, currencies. Used by the
          estimation engine to price team proposals. Edits never retroactively
          change past estimates — each estimate snapshots the rate table it was
          priced against.
        </p>
      </div>
      <RateCardsAdmin />
    </div>
  );
}
