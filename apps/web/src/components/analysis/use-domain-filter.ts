"use client";

/**
 * Small hook for the analysis lists — reads the `?domain=<key>` param
 * set by the clickable domain badges in `AnalysisPageShell`. Returns
 * `null` when no filter is active so callers can skip the filter pass.
 *
 * We deliberately keep the filter client-side (Array.prototype.filter
 * on the already-fetched list) rather than push it into the tRPC
 * procedure: the per-assessment row count is small, and filtering
 * client-side means switching domains is instantaneous with no
 * network round-trip.
 */
import { useSearchParams } from "next/navigation";

export function useDomainFilter(): string | null {
  const params = useSearchParams();
  const v = params.get("domain");
  return v && v.length > 0 ? v : null;
}
