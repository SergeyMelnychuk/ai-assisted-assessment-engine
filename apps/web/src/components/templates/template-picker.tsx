"use client";

import { useEffect } from "react";
import type { TemplateKind } from "@prisma/client";
import { trpc } from "@/lib/trpc";
import { Label } from "@/components/ui/label";

/**
 * Template picker for the Team & Estimate / Deliverables popups.
 *
 * Behavior:
 *   - Lists APPROVED, non-archived templates the caller can use for
 *     `kind` (engagement-scoped first, then workspace defaults).
 *   - Preselects whichever option `pickerOptions` flagged as
 *     `isDefault` (mirrors `resolveTemplateForAssessment`).
 *   - Hides itself when zero options exist — the worker falls back to
 *     the auto-resolver (which finds nothing and skips the fill).
 *
 * The selected `templateId` is reported to the parent via
 * `onChange`; the parent forwards it to the enqueueing mutation.
 */
export function TemplatePicker({
  engagementId,
  kind,
  value,
  onChange,
  label = "Template",
}: {
  engagementId: string;
  kind: TemplateKind;
  /** Selected template id; undefined means "let the auto-resolver pick". */
  value: string | undefined;
  onChange: (id: string | undefined) => void;
  label?: string;
}) {
  const optionsQuery = trpc.template.pickerOptions.useQuery({
    engagementId,
    kind,
  });
  const options = optionsQuery.data ?? [];
  const defaultId = options.find((o) => o.isDefault)?.id;

  // Preselect the default option once the list lands. We only seed
  // `value` when the parent hasn't picked anything yet — never
  // overwrite a user's explicit choice.
  useEffect(() => {
    if (value === undefined && defaultId) {
      onChange(defaultId);
    }
    // Intentionally leave `onChange` out of deps — parents typically
    // pass an inline arrow which would re-trigger this every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultId, value]);

  if (optionsQuery.isLoading) {
    return (
      <p className="text-xs text-muted-foreground">Loading templates…</p>
    );
  }
  // Hide entirely when no options — keeps the popup uncluttered for
  // engagements that haven't uploaded a template.
  if (options.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <Label htmlFor="template-picker" className="text-sm">
        {label}
      </Label>
      <select
        id="template-picker"
        className="block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || undefined)}
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name} v{o.version}
            {o.scope === "workspace" ? " (workspace default)" : ""}
            {o.isDefault ? " — default" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
