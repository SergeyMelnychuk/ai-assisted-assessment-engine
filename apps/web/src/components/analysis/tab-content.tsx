"use client";

import { Suspense } from "react";
import { ViewToggle, useViewMode } from "./view-toggle";
import { FindingsList } from "./findings-list";
import { RisksList } from "./risks-list";
import { RecommendationsList } from "./recommendations-list";
import { ScoringList } from "./scoring-list";
import { FindingsDashboardView } from "./findings-dashboard-view";
import { RisksDashboardView } from "./risks-dashboard-view";
import { RecommendationsDashboardView } from "./recommendations-dashboard-view";
import { ScoringDashboardView } from "./scoring-dashboard-view";

/**
 * Per-tab wrapper that reads `?view=dashboard|list` from the URL and
 * renders the matching body. The toggle lives at the top of the body
 * (under the shared AnalysisPageShell header) so every tab gets the
 * same placement without pushing the choice up into each page.tsx.
 *
 * `useSearchParams` requires a Suspense boundary under Next 15 when the
 * page is rendered in RSC-first mode. The inner body isn't heavy so we
 * scope the Suspense narrowly around the whole switcher.
 */
export function AnalysisTabContent({
  tab,
  assessmentId,
  engagementId,
}: {
  tab: "findings" | "risks" | "recommendations" | "scoring";
  assessmentId: string;
  engagementId: string;
}) {
  return (
    <Suspense fallback={null}>
      <Inner tab={tab} assessmentId={assessmentId} engagementId={engagementId} />
    </Suspense>
  );
}

function Inner({
  tab,
  assessmentId,
  engagementId,
}: {
  tab: "findings" | "risks" | "recommendations" | "scoring";
  assessmentId: string;
  engagementId: string;
}) {
  const [view, setView] = useViewMode();
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <ViewToggle value={view} onChange={setView} />
      </div>
      {view === "dashboard" ? (
        tab === "findings" ? (
          <FindingsDashboardView assessmentId={assessmentId} />
        ) : tab === "risks" ? (
          <RisksDashboardView assessmentId={assessmentId} />
        ) : tab === "recommendations" ? (
          <RecommendationsDashboardView assessmentId={assessmentId} />
        ) : (
          <ScoringDashboardView assessmentId={assessmentId} />
        )
      ) : tab === "findings" ? (
        <FindingsList assessmentId={assessmentId} engagementId={engagementId} />
      ) : tab === "risks" ? (
        <RisksList assessmentId={assessmentId} engagementId={engagementId} />
      ) : tab === "recommendations" ? (
        <RecommendationsList
          assessmentId={assessmentId}
          engagementId={engagementId}
        />
      ) : (
        <ScoringList assessmentId={assessmentId} />
      )}
    </div>
  );
}
