"use client";

import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LogsTab } from "./logs-tab";
import { UsageTab } from "./usage-tab";
import { AiRouterTab } from "./ai-router-tab";

/**
 * Tab shell for `/admin/settings`.
 *
 * The active tab is mirrored into `?tab=` so back/forward and deep
 * links behave. We don't mount the inactive tabs — `LogsTab` and
 * `UsageTab` issue their own tRPC queries and keeping three hot
 * subscribers wastes a polling interval per off-screen panel.
 *
 * Tab content is owned by three different agents; this component is
 * the only place their files are wired together. Keep the import
 * names stable (`SettingsTab` / `LogsTab` / `UsageTab`) so cross-agent
 * renames don't cascade through the page.
 */

type TabKey = "logs" | "usage" | "ai-router";

// Display order is Logs → AI Usage → AI Router. Ops-first: an admin
// visiting this page is usually debugging (Logs) or auditing spend
// (AI Usage); tuning the router is less frequent.
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "logs", label: "Logs" },
  { key: "usage", label: "AI Usage" },
  { key: "ai-router", label: "AI Router" },
];

// `?tab=settings` was the old "Concurrency" tab. Its content now
// lives inside the AI Router tab (one cohesive place for
// AI-behaviour tuning), so old bookmarks resolve there instead of
// 404-ing or silently dropping to the default.
function parseTab(raw: string | null): TabKey {
  if (raw === "usage" || raw === "ai-router") return raw;
  if (raw === "settings") return "ai-router";
  return "logs";
}

export function SettingsPageTabs() {
  const router = useRouter();
  const params = useSearchParams();
  const active = parseTab(params.get("tab"));

  // `router.replace` keeps the URL in sync without pushing a new entry
  // per click — tab flicks shouldn't pollute history.
  const select = useCallback(
    (key: TabKey) => {
      const next = new URLSearchParams(params);
      next.set("tab", key);
      router.replace(`?${next.toString()}`, { scroll: false });
    },
    [params, router],
  );

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="Admin settings sections"
        className="inline-flex rounded-lg border bg-muted/40 p-1"
      >
        {TABS.map((t) => {
          const isActive = t.key === active;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => select(t.key)}
              className={
                "px-4 py-1.5 text-sm font-medium rounded-md transition-colors " +
                (isActive
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div role="tabpanel">
        {active === "logs" && <LogsTab />}
        {active === "usage" && <UsageTab />}
        {active === "ai-router" && <AiRouterTab />}
      </div>
    </div>
  );
}
