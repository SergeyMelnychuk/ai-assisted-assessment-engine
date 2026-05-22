"use client";

/**
 * User-friendly banner for a failed AI run. Consumes the classified
 * failure shape returned by `analysis.lastFailure` (or the job audit
 * log). Picks a tone from the category so BILLING / MODEL / STORAGE
 * issues look different from a transient 529 / malformed-response.
 */
interface FailureLike {
  category: string;
  label: string;
  userMessage: string;
  nextStep: string;
  isRetryable: boolean;
  needsAdmin: boolean;
  failedAt?: Date | string;
  action?: string;
}

// Body text uses `text-foreground` for max contrast (near-black on
// light, near-white on dark). The category tint lives on the border,
// background, and icon only — tinted body copy (e.g. amber-900) read
// as washed-out in practice, especially under the header's opacity
// treatments.
const CATEGORY_TONE: Record<string, { border: string; bg: string; text: string; icon: string }> = {
  AI_BILLING: {
    border: "border-amber-500/40",
    bg: "bg-amber-500/10",
    text: "text-foreground",
    icon: "💳",
  },
  AI_MODEL: {
    border: "border-amber-500/40",
    bg: "bg-amber-500/10",
    text: "text-foreground",
    icon: "⚙️",
  },
  AI_AUTH: {
    border: "border-destructive/40",
    bg: "bg-destructive/10",
    text: "text-foreground",
    icon: "🔒",
  },
  AI_RATE_LIMITED: {
    border: "border-blue-500/40",
    bg: "bg-blue-500/10",
    text: "text-foreground",
    icon: "⏳",
  },
  AI_OVERLOADED: {
    border: "border-blue-500/40",
    bg: "bg-blue-500/10",
    text: "text-foreground",
    icon: "⏳",
  },
  AI_OUTPUT_TOO_LARGE: {
    border: "border-amber-500/40",
    bg: "bg-amber-500/10",
    text: "text-foreground",
    icon: "📏",
  },
  AI_MALFORMED: {
    border: "border-muted-foreground/40",
    bg: "bg-muted",
    text: "text-foreground",
    icon: "🤖",
  },
  AI_EMPTY: {
    border: "border-muted-foreground/40",
    bg: "bg-muted",
    text: "text-foreground",
    icon: "🤖",
  },
  NO_TEXT: {
    border: "border-muted-foreground/40",
    bg: "bg-muted",
    text: "text-foreground",
    icon: "📄",
  },
  STORAGE: {
    border: "border-destructive/40",
    bg: "bg-destructive/10",
    text: "text-foreground",
    icon: "☁️",
  },
  DB: {
    border: "border-destructive/40",
    bg: "bg-destructive/10",
    text: "text-foreground",
    icon: "🗄️",
  },
  ANALYSIS_PARTIAL_FAILURE: {
    border: "border-amber-500/40",
    bg: "bg-amber-500/10",
    text: "text-foreground",
    icon: "⚠️",
  },
  INGEST_EXTRACTION_FAILED: {
    border: "border-muted-foreground/40",
    bg: "bg-muted",
    text: "text-foreground",
    icon: "📄",
  },
  INGEST_CHUNK_FAILED: {
    border: "border-muted-foreground/40",
    bg: "bg-muted",
    text: "text-foreground",
    icon: "📄",
  },
  UNKNOWN: {
    border: "border-muted-foreground/40",
    bg: "bg-muted",
    text: "text-foreground",
    icon: "⚠️",
  },
};

export function FailureBanner({
  failure,
  title,
  onRetry,
  retrying,
  onDismiss,
  dismissing,
}: {
  failure: FailureLike;
  /** Short context headline (e.g. "Analysis run"). */
  title?: string;
  onRetry?: () => void;
  retrying?: boolean;
  /** When set, renders a close (×) control. The host owns the action
   *  — most callers wire it to a server-side dismiss so the banner
   *  stays gone across reloads. */
  onDismiss?: () => void;
  dismissing?: boolean;
}) {
  const tone = CATEGORY_TONE[failure.category] ?? CATEGORY_TONE.UNKNOWN;

  return (
    <div
      role="alert"
      className={`relative rounded-md border ${tone.border} ${tone.bg} p-4 ${tone.text}`}
    >
      {onDismiss ? (
        <button
          type="button"
          aria-label="Dismiss failure banner"
          onClick={onDismiss}
          disabled={dismissing}
          className="absolute right-2 top-2 rounded-md p-1 text-current opacity-60 transition-opacity hover:opacity-100 disabled:opacity-30"
        >
          <span aria-hidden className="text-lg leading-none">
            ×
          </span>
        </button>
      ) : null}
      <div className="flex flex-wrap items-start gap-3">
        <span aria-hidden className="text-xl leading-none">
          {tone.icon}
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <h3 className="text-sm font-semibold">
              {title ? `${title}: ` : ""}
              {failure.label}
            </h3>
            {failure.needsAdmin ? (
              <span className="inline-flex items-center rounded-full border border-current/40 px-2 py-0.5 text-xs font-medium opacity-80">
                admin action needed
              </span>
            ) : null}
            {failure.failedAt ? (
              <span className="text-xs text-muted-foreground">
                {new Date(failure.failedAt).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </span>
            ) : null}
          </div>
          <p className="text-sm leading-relaxed">{failure.userMessage}</p>
          <p className="text-sm leading-relaxed">{failure.nextStep}</p>
          {onRetry && failure.isRetryable ? (
            <button
              type="button"
              onClick={onRetry}
              disabled={retrying}
              className="mt-1 rounded-md border border-current/40 px-3 py-1 text-xs font-medium opacity-90 hover:opacity-100 disabled:opacity-50"
            >
              {retrying ? "Retrying…" : "Retry"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
