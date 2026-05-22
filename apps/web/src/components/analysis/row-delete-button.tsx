"use client";

import { useState } from "react";

/**
 * Compact trash-icon button with two-step inline confirmation. Used
 * on findings / risks / recommendations / scoring list rows.
 *
 * Design choices:
 * - Two-step (click → "Confirm delete") instead of a full modal,
 *   because these lists can be long and modal thrash on every row
 *   click would feel heavy. The arm-then-confirm pattern is still
 *   safe: no single click permanently destroys data.
 * - When `disabled` is true (viewer lacks OWNER/ADMIN privilege) we
 *   render nothing. No greyed-out button — avoids teasing readers
 *   with an action they can't take, and keeps list rows cleaner.
 * - The confirm button uses destructive red + live `pending` state
 *   so users know the click landed and aren't tempted to double-click.
 */
export function DeleteRowButton({
  onDelete,
  pending,
  label = "Delete",
  confirmLabel = "Confirm delete",
  disabled,
}: {
  onDelete: () => void;
  pending?: boolean;
  label?: string;
  confirmLabel?: string;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);

  if (disabled) return null;

  if (armed) {
    return (
      <span className="inline-flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            onDelete();
            setArmed(false);
          }}
          disabled={pending}
          className="inline-flex items-center rounded-md border border-destructive/60 bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/20 disabled:opacity-50"
        >
          {pending ? "Deleting…" : confirmLabel}
        </button>
        <button
          type="button"
          onClick={() => setArmed(false)}
          disabled={pending}
          className="text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => setArmed(true)}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
    >
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
      >
        <path d="M3 6h18" strokeLinecap="round" />
        <path
          d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
          strokeLinecap="round"
        />
        <path
          d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M10 11v6" strokeLinecap="round" />
        <path d="M14 11v6" strokeLinecap="round" />
      </svg>
    </button>
  );
}
