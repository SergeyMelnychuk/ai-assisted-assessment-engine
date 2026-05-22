"use client";

import { useState } from "react";
import { TemplatePicker } from "@/components/templates/template-picker";
import { TemplateFillDownload } from "@/components/templates/template-fill-download";
import { RunEstimationButton } from "@/components/assessment/run-estimation-button";

/**
 * Run-controls panel for the standalone Team & Estimate page.
 * Mirrors what `TeamEstimateStepBody` does inside the workflow popup:
 * picker on top, run button next to it, download link below for
 * whichever populated WBS came out of the most recent fill.
 *
 * Lives as its own component because the page is a server component
 * — picker + button hold local state and need "use client".
 */
export function TeamEstimateRunPanel({
  assessmentId,
  engagementId,
}: {
  assessmentId: string;
  engagementId: string;
}) {
  const [templateId, setTemplateId] = useState<string | undefined>(undefined);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <TemplatePicker
          engagementId={engagementId}
          kind="ESTIMATION"
          value={templateId}
          onChange={setTemplateId}
          label="WBS / estimation template"
        />
        <RunEstimationButton
          assessmentId={assessmentId}
          variant="secondary"
          templateId={templateId}
        />
      </div>
      <TemplateFillDownload assessmentId={assessmentId} kind="ESTIMATION" />
    </div>
  );
}
