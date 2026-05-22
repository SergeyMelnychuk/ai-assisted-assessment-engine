"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RunAnalysisButton } from "./run-analysis-button";
import { ClearAllButton } from "./clear-all-button";
import { CancelAnalysisButton } from "./cancel-analysis-button";
import { FailureBanner } from "@/components/common/failure-banner";
import { domainLabel } from "@/lib/domain-labels";

/**
 * Wraps the four analysis tabs in a shared header: tab links, counts from
 * the `analysis.summary` tRPC endpoint, and a persistent "Run analysis"
 * trigger. Keeps the pages themselves to a single `<List />` render.
 *
 * Polling was removed deliberately — background polling generated a
 * constant stream of `analysis.summary` / `analysis.lastFailure` /
 * `analysis.perDomainStatus` hits even when nothing was happening. The
 * shell now fetches once on mount; the user explicitly clicks
 * "Refresh" to re-fetch all analysis-related queries, and the
 * "Run analysis" mutation invalidates them on success so results
 * still show up immediately after the worker finishes (a Refresh
 * click later catches the final counts).
 */
export function AnalysisPageShell({
  engagementId,
  assessmentId,
  active,
  children,
}: {
  engagementId: string;
  assessmentId: string;
  active: "findings" | "risks" | "recommendations" | "scoring";
  children: React.ReactNode;
}) {
  const utils = trpc.useUtils();
  // The active domain filter lives in `?domain=<key>` so it's
  // shareable, survives tab switches (the Link hrefs preserve it),
  // and every list can read it with `useSearchParams()`. Empty /
  // missing = "no domain filter".
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeDomain = searchParams.get("domain") ?? null;
  // Preserve the `?view=dashboard` mode across badge/tab clicks.
  // Default (`list`) is represented by the absence of the param, so
  // we only carry it through when it's been explicitly set — keeps
  // URLs clean when the admin hasn't switched views.
  const activeView =
    searchParams.get("view") === "dashboard" ? "dashboard" : null;
  const summaryQuery = trpc.analysis.summary.useQuery({ assessmentId });
  // Show the last failure banner if the most recent terminal job event
  // was a failure. The server suppresses stale failures as soon as a
  // new `ENQUEUE_ANALYSIS` row lands, so kicking a new run hides the
  // old banner immediately after invalidation.
  const failureQuery = trpc.analysis.lastFailure.useQuery({ assessmentId });
  const dismissFailure = trpc.analysis.dismissLastFailure.useMutation({
    onSuccess: async () => {
      await utils.analysis.lastFailure.invalidate({ assessmentId });
    },
  });

  // Refresh all analysis-surface queries on demand. Invalidating the
  // whole `analysis.*` namespace picks up summary + lastFailure +
  // perDomainStatus; the four list queries are invalidated separately
  // since they live under their own routers.
  const refreshAll = async () => {
    await Promise.all([
      utils.analysis.invalidate(undefined, { refetchType: "active" }),
      utils.finding.listByAssessment.invalidate({ assessmentId }),
      utils.risk.listByAssessment.invalidate({ assessmentId }),
      utils.recommendation.listByAssessment.invalidate({ assessmentId }),
      utils.scoring.listByAssessment.invalidate({ assessmentId }),
    ]);
  };
  const refreshing =
    summaryQuery.isFetching || failureQuery.isFetching;

  const tabs = [
    { key: "findings", label: "Findings", count: summaryQuery.data?.findings },
    { key: "risks", label: "Risks", count: summaryQuery.data?.risks },
    {
      key: "recommendations",
      label: "Recommendations",
      count: summaryQuery.data?.recommendations,
    },
    {
      key: "scoring",
      label: "Scoring",
      count: summaryQuery.data?.domainScores,
    },
  ] as const;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1 rounded-md border bg-muted/20 p-1">
          {tabs.map((t) => (
            <Link
              key={t.key}
              href={`/engagements/${engagementId}/${t.key}?${buildTabSearch({ assessmentId, domain: activeDomain, view: activeView })}`}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                active === t.key
                  ? "bg-background shadow-sm"
                  : "text-muted-foreground hover:bg-background/60"
              }`}
            >
              {t.label}
              {summaryQuery.isLoading ? null : t.count !== undefined ? (
                <span className="ml-1.5 text-xs text-muted-foreground">
                  {t.count}
                </span>
              ) : null}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void refreshAll()}
            disabled={refreshing}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
          <ClearAllButton assessmentId={assessmentId} category={active} />
          <RunAnalysisButton
            assessmentId={assessmentId}
            variant="secondary"
          />
        </div>
      </div>
      {/* "Run in progress" banner — lifts the Cancel control out of the
          tab-scoped button row so it's visually clear it applies to
          the whole analysis run (not just the currently selected tab). */}
      <InFlightBanner assessmentId={assessmentId} />
      {summaryQuery.isLoading ? (
        <Skeleton className="h-4 w-40" />
      ) : null}
      {failureQuery.data ? (
        <FailureBanner
          failure={failureQuery.data}
          title={labelForAction(failureQuery.data.action)}
          onDismiss={() => dismissFailure.mutate({ assessmentId })}
          dismissing={dismissFailure.isPending}
        />
      ) : null}
      <PerDomainStatus
        assessmentId={assessmentId}
        pathname={pathname}
        activeDomain={activeDomain}
        activeView={activeView}
      />
      {children}
    </div>
  );
}

/**
 * Banner that surfaces while a run is enqueued/executing. Renders
 * nothing when no run is in flight. The Cancel control lives here
 * (instead of next to Run/Clear-all) so it's obvious the cancel
 * applies to the whole run — not just the Findings / Risks / etc.
 * tab the user happens to be viewing.
 *
 * Embeds a per-domain progress strip powered by
 * `analysis.runProgress` so the user sees *which* domain is running
 * right now and how far through the fan-out they are — the lack of
 * visible progress previously produced panic-cancels (see 2026-04-19
 * log export).
 */
export function InFlightBanner({ assessmentId }: { assessmentId: string }) {
  const statusQuery = trpc.analysis.runStatus.useQuery({ assessmentId });
  const inFlight = statusQuery.data?.inFlight ?? false;
  // Poll progress only while the banner is shown. 3 s is a good match
  // for domain call durations of 60–120 s — fast enough to feel live,
  // slow enough not to hammer the DB.
  const progressQuery = trpc.analysis.runProgress.useQuery(
    { assessmentId },
    {
      enabled: inFlight,
      refetchInterval: inFlight ? 3_000 : false,
    },
  );
  if (!inFlight) return null;
  const progress = progressQuery.data ?? null;
  return (
    <div className="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-foreground">
          <span
            aria-hidden
            className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500"
          />
          <span>
            Analysis run in progress
            {progress
              ? ` — ${progress.completed} / ${progress.total} domains complete` +
                (progress.running > 0 ? `, ${progress.running} running` : "") +
                (progress.failed > 0 ? `, ${progress.failed} failed` : "")
              : " — results will update for all four tabs (findings, risks, recommendations, scoring)."}
          </span>
        </div>
        <CancelAnalysisButton assessmentId={assessmentId} />
      </div>
      {progress && progress.domains.length > 0 ? (
        <PerDomainProgress domains={progress.domains} />
      ) : null}
    </div>
  );
}

/**
 * Compact domain-by-domain progress strip. Each pill shows its
 * current status icon, the domain label, and — for the domain that's
 * live — a rolling elapsed-time counter.
 */
function PerDomainProgress({
  domains,
}: {
  domains: Array<{
    domain: string;
    status: "pending" | "running" | "complete" | "failed";
    startedAt: string | Date | null;
    durationMs: number | null;
    error: string | null;
  }>;
}) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {domains.map((d) => (
        <li key={d.domain}>
          <DomainProgressPill
            domain={d.domain}
            status={d.status}
            startedAt={d.startedAt}
            durationMs={d.durationMs}
            error={d.error}
          />
        </li>
      ))}
    </ul>
  );
}

function DomainProgressPill({
  domain,
  status,
  startedAt,
  durationMs,
  error,
}: {
  domain: string;
  status: "pending" | "running" | "complete" | "failed";
  startedAt: string | Date | null;
  durationMs: number | null;
  error: string | null;
}) {
  // Live elapsed counter for the running domain. Re-renders once a
  // second via a local timer; the parent re-fetches progress every
  // 3 s, which is the authoritative state update.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status !== "running") return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [status]);

  const elapsedSec =
    status === "running" && startedAt
      ? Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000))
      : null;
  const durationSec =
    durationMs !== null ? Math.max(1, Math.round(durationMs / 1000)) : null;

  const tone =
    status === "complete"
      ? "border-emerald-500/40 bg-emerald-500/10 text-foreground"
      : status === "running"
        ? "border-amber-500/60 bg-amber-500/15 text-foreground"
        : status === "failed"
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-border bg-muted/40 text-muted-foreground";
  const icon =
    status === "complete"
      ? "✓"
      : status === "running"
        ? "↻"
        : status === "failed"
          ? "✗"
          : "·";

  const title =
    status === "failed" && error
      ? error
      : status === "complete" && durationSec !== null
        ? `done in ${durationSec}s`
        : status === "running" && elapsedSec !== null
          ? `running for ${elapsedSec}s`
          : status;

  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${tone}`}
    >
      <span aria-hidden className={status === "running" ? "animate-pulse" : ""}>
        {icon}
      </span>
      <span className="font-medium">{domainLabel(domain)}</span>
      {status === "running" && elapsedSec !== null ? (
        <span className="tabular-nums text-muted-foreground">{elapsedSec}s</span>
      ) : status === "complete" && durationSec !== null ? (
        <span className="tabular-nums text-muted-foreground">{durationSec}s</span>
      ) : null}
    </span>
  );
}

/**
 * Per-domain fan-out status strip — Phase 3 Week 2 (ADR-0002).
 * Renders one badge per active domain with its analysis + scoring
 * status ("ok", "failed", or "—"). When at least one domain failed,
 * a FailureBanner is rendered above the grid so the succeeded
 * domains' results stay visible underneath.
 */
function PerDomainStatus({
  assessmentId,
  pathname,
  activeDomain,
  activeView,
}: {
  assessmentId: string;
  pathname: string;
  activeDomain: string | null;
  activeView: "dashboard" | null;
}) {
  const statusQuery = trpc.analysis.perDomainStatus.useQuery({ assessmentId });
  const data = statusQuery.data;
  if (!data || data.domains.length === 0) return null;
  const failedDomains = data.domains.filter(
    (d) => d.analysis === "failed" || d.scoring === "failed",
  );

  // Map the engine-side enum to the UI label the user actually sees
  // (Draft / Reviewed). Keep the server-side FAST/THOROUGH enum intact —
  // it describes the mechanical path, the UI label describes the
  // product intent (ADR-0013). Legacy rows without a stamped mode get
  // an honest "—" instead of a guessed default.
  const modeLabel =
    data.mode === "THOROUGH"
      ? "Reviewed"
      : data.mode === "FAST"
        ? "Draft"
        : "—";
  const completedLabel = new Date(data.completedAt).toLocaleString();

  return (
    <div className="space-y-3">
      {data.partial && failedDomains.length > 0 ? (
        <FailureBanner
          failure={{
            category: "ANALYSIS_PARTIAL_FAILURE",
            label: `${failedDomains.length} domain(s) failed`,
            userMessage:
              "Analysis succeeded for most domains but failed for some. The succeeded domains' findings, risks, and scores are saved below; only the failed domains need a retry.",
            nextStep:
              "Use the Run analysis button to retry. Reviewed rows are preserved; DRAFT rows will be overwritten.",
            isRetryable: true,
            needsAdmin: false,
          }}
          title="Partial success"
        />
      ) : null}
      {/* Header strip: answers the user's "what mode was this and when?"
          question without forcing them to hover each badge. The mode
          label here is the *outcome* of the last run — the Run analysis
          button to the right is the input for the next one. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          Last run:{" "}
          <span className="font-medium text-foreground">{modeLabel}</span>
        </span>
        <span aria-hidden>·</span>
        <span>{completedLabel}</span>
        {data.hasVerifyLeg ? (
          <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-900 dark:text-emerald-200">
            verifier applied
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {data.domains
          // Hide badges for domains whose every leg has been cleared
          // (no findings/risks/recs/scoring left) — the server nulls
          // those legs explicitly. Keeping an "Architecture —/—" badge
          // after the user just deleted that domain's outputs is
          // misleading; no badge is the honest signal.
          .filter(
            (d) =>
              d.analysis !== null ||
              d.scoring !== null ||
              d.verify !== null,
          )
          .map((d) => (
            <DomainBadge
              key={d.domain}
              domain={d}
              showVerify={data.hasVerifyLeg}
              href={`${pathname}?${buildTabSearch({
                assessmentId,
                // Toggle: clicking the active badge removes the filter.
                domain: activeDomain === d.domain ? null : d.domain,
                view: activeView,
              })}`}
              isActive={activeDomain === d.domain}
              isDimmed={activeDomain !== null && activeDomain !== d.domain}
            />
          ))}
      </div>
      {activeDomain ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            Filtered to{" "}
            <span className="font-medium text-foreground">
              {domainLabel(activeDomain)}
            </span>
            . Click the badge again or
          </span>
          <Link
            href={`${pathname}?${buildTabSearch({ assessmentId, domain: null, view: activeView })}`}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            clear filter
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function DomainBadge({
  domain,
  showVerify,
  href,
  isActive,
  isDimmed,
}: {
  domain: {
    domain: string;
    analysis: "ok" | "failed" | null;
    scoring: "ok" | "failed" | null;
    verify: "ok" | "failed" | null;
  };
  /** True iff the last run was Reviewed/THOROUGH. Drives whether the
   *  badge shows the middle `Verify:` leg — hiding it on Draft runs
   *  keeps the badge compact and makes "this run was reviewed"
   *  glanceable. */
  showVerify: boolean;
  /** Clicking the badge navigates here — toggles the URL `?domain=…`
   *  filter read by every list in the analysis section. */
  href: string;
  /** Badge corresponds to the currently-filtered domain. Renders with
   *  a ring + bumped font weight so the "one-of-many" selection reads
   *  at a glance. */
  isActive: boolean;
  /** Some other badge is the active filter — dim the rest so the
   *  selection is the visual focal point. */
  isDimmed: boolean;
}) {
  const analysisOk = domain.analysis === "ok";
  const scoringOk = domain.scoring === "ok";
  const analysisFailed = domain.analysis === "failed";
  const scoringFailed = domain.scoring === "failed";
  // Verifier failures are best-effort (ADR-0013) — generator output is
  // kept — so a failed verifier does NOT tint the badge red. Only the
  // generator + scoring legs drive the emerald/red tone. We still show
  // `Verify:failed` in the leg itself so the signal isn't hidden.
  const anyFailed = analysisFailed || scoringFailed;
  // Text tone matches the other pill labels (gap / HIGH / confidence /
  // draft / domain chip on the findings page) which all use
  // `text-muted-foreground` on tinted backgrounds — category hue reads
  // from the border + bg, the label copy stays readable in both themes.
  // Destructive still uses `text-destructive` so a failed leg pops.
  const tone = anyFailed
    ? "border-destructive/40 bg-destructive/10 text-destructive"
    : analysisOk || scoringOk
      ? "border-emerald-500/40 bg-emerald-500/10 text-muted-foreground"
      : "border-muted-foreground/30 bg-muted text-muted-foreground";
  const labelFor = (s: "ok" | "failed" | null): string =>
    s === "ok" ? "ok" : s === "failed" ? "failed" : "—";
  const title = showVerify
    ? `analysis: ${labelFor(domain.analysis)} · verify: ${labelFor(domain.verify)} · scoring: ${labelFor(domain.scoring)}`
    : `analysis: ${labelFor(domain.analysis)} · scoring: ${labelFor(domain.scoring)}`;
  const interactive =
    "transition hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const ring = isActive ? "ring-2 ring-ring" : "";
  const dim = isDimmed ? "opacity-60" : "";
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${tone} ${interactive} ${ring} ${dim}`}
      title={`${isActive ? "Remove filter · " : "Filter to this domain · "}${title}`}
      aria-pressed={isActive}
    >
      <span className={isActive ? "font-semibold" : "font-medium"}>
        {domainLabel(domain.domain)}
      </span>
      {/* Per-leg outcome. Analysis = generator Claude call. Verify =
          optional reviewer pass (Reviewed mode only — hidden in Draft).
          Scoring = 0–5 maturity rubric call. Each is a separate Claude
          call so a domain with partial output stays diagnosable. The
          legs inherit the badge tone's full text color — they used to
          be `opacity-70` but that washed them out on light backgrounds. */}
      <span>Analysis:{labelFor(domain.analysis)}</span>
      {showVerify ? <span>Verify:{labelFor(domain.verify)}</span> : null}
      <span>Scoring:{labelFor(domain.scoring)}</span>
    </Link>
  );
}

/**
 * Build the query string for a tab / badge link. Keeps `assessmentId`
 * always present (the lists need it to fetch) and carries the optional
 * `domain` filter through every link the shell renders — so clicking
 * a tab or a domain badge preserves the other axis.
 */
function buildTabSearch({
  assessmentId,
  domain,
  view,
}: {
  assessmentId: string;
  domain: string | null;
  /** `"dashboard"` or null. We omit the param for the default (`list`)
   *  to keep URLs clean — `useViewMode()` reads absence as `list`. */
  view?: "dashboard" | null;
}): string {
  const params = new URLSearchParams();
  params.set("assessmentId", assessmentId);
  if (domain) params.set("domain", domain);
  if (view) params.set("view", view);
  return params.toString();
}

function labelForAction(action: string | undefined): string {
  switch (action) {
    case "RUN_ANALYSIS_FAILED":
      return "Analysis run";
    case "RUN_ESTIMATION_FAILED":
      return "Team & estimate run";
    case "GENERATE_DELIVERABLE_FAILED":
      return "Deliverable generation";
    default:
      return "Last run";
  }
}
