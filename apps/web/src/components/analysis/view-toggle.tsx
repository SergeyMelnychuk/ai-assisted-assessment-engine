"use client";

import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * URL-persisted `?view=list|dashboard` segmented toggle. Sits at the
 * top of each analysis tab so a shared link opens in the same mode.
 * Default when the query is absent is `list`; switching back to `list`
 * strips the param (prevents URL noise).
 */
export type AnalysisView = "list" | "dashboard";

export function useViewMode(): [AnalysisView, (next: AnalysisView) => void] {
  const router = useRouter();
  const searchParams = useSearchParams();
  const raw = searchParams.get("view");
  const current: AnalysisView = raw === "dashboard" ? "dashboard" : "list";
  const setView = useCallback(
    (next: AnalysisView) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === "list") {
        params.delete("view");
      } else {
        params.set("view", next);
      }
      const qs = params.toString();
      router.replace(qs ? `?${qs}` : "?", { scroll: false });
    },
    [router, searchParams],
  );
  return [current, setView];
}

export function ViewToggle({
  value,
  onChange,
}: {
  value: AnalysisView;
  onChange: (next: AnalysisView) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="View mode"
      className="inline-flex rounded-md border bg-muted/20 p-0.5 text-sm"
    >
      {(["list", "dashboard"] as const).map((v) => {
        const active = value === v;
        return (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(v)}
            className={`rounded-sm px-3 py-1 text-xs font-medium capitalize transition-colors ${
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-background/60"
            }`}
          >
            {v}
          </button>
        );
      })}
    </div>
  );
}
