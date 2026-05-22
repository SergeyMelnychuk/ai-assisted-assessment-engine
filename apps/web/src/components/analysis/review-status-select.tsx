"use client";

const STATUSES = [
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
  "NEEDS_REVISION",
] as const;

/**
 * Inline select for the `reviewStatus` column. Wired to whichever update
 * mutation the parent passes in — keeps the list components simple.
 */
export function ReviewStatusSelect({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  onChange: (next: (typeof STATUSES)[number]) => void;
}) {
  return (
    <select
      className="rounded-md border border-input bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as (typeof STATUSES)[number])}
    >
      {STATUSES.map((s) => (
        <option key={s} value={s}>
          {s.replace(/_/g, " ").toLowerCase()}
        </option>
      ))}
    </select>
  );
}
