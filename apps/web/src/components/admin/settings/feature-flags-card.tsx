"use client";

import Link from "next/link";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Feature flags card on the AI Router tab.
 *
 * Flags are DB-backed only — no env layer. Toggle takes effect on the
 * next tRPC call (settings-service caches per process for ~10 s).
 *
 * Shape is intentionally one row per flag — when a second flag lands
 * (e.g. a per-tenant agent gate) it drops in here next to the first
 * with no layout work.
 */
export function FeatureFlagsCard() {
  const query = trpc.adminSettings.getFeatureFlags.useQuery();
  const utils = trpc.useUtils();
  const set = trpc.adminSettings.setFeatureFlag.useMutation({
    onSuccess: async () => {
      // Invalidate both the admin read and the public flag surface so
      // client components picking up via `useFeatureFlags()` refetch
      // immediately after a toggle.
      await Promise.all([
        utils.adminSettings.getFeatureFlags.invalidate(),
        utils.features.list.invalidate(),
      ]);
    },
  });

  if (query.isLoading || !query.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Feature flags</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Loading flags…
        </CardContent>
      </Card>
    );
  }

  const agentEnabled = query.data.agentEnabled;
  const autoClassifyChunks = query.data.autoClassifyChunks;
  const agentFlowVisible = query.data.agentFlowVisible;
  const hybridRetrieval = query.data.hybridRetrieval;
  const busy = set.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Feature flags</CardTitle>
        {/* Plain <div> — we need block children (paragraph + link)
            and CardDescription renders a <p>, which can't contain
            another <p>. */}
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            Turn optional product features on or off for everyone in
            the workspace. Changes apply within a few seconds — no
            restart or redeploy needed.
          </p>
          <p>
            For what each feature does and when to turn it on, see
            the{" "}
            <Link
              href="/admin/guides/ai-router#feature-flags"
              className="font-medium text-primary underline-offset-2 hover:underline"
            >
              AI Router guide
            </Link>
            .
          </p>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-start justify-between gap-6 border-t pt-4">
          <div className="space-y-1 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">
                Autonomous evidence collection
              </span>
              <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
                Preview
              </span>
            </div>
            <div className="text-muted-foreground">
              Lets an assessment gather evidence automatically from
              connected systems (repositories, CI, cloud read-only)
              alongside the usual uploads and questionnaire answers.
              Off by default — when off, the option is hidden from
              assessment creation and no autonomous runs can start.
            </div>
            <div className="text-muted-foreground">
              The runtime flow (assessment picker, plan approval,
              live run view) ships over the next few releases —
              turning this on today records your intent but does
              not yet expose a <em>Start a run</em> button. See the{" "}
              <Link
                href="/admin/guides/ai-router#autonomous-evidence-collection"
                className="font-medium text-primary underline-offset-2 hover:underline"
              >
                guide
              </Link>{" "}
              for the full rollout timeline.
            </div>
            <div className="pt-1 text-xs text-muted-foreground">
              <span className="font-medium">Status:</span>{" "}
              <span
                className={
                  agentEnabled
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-muted-foreground"
                }
              >
                {agentEnabled ? "On" : "Off"}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              size="sm"
              variant={agentEnabled ? "secondary" : "default"}
              disabled={busy || agentEnabled}
              onClick={() =>
                set.mutate({
                  key: "features.agentEnabled" as const,
                  enabled: true,
                })
              }
            >
              Turn on
            </Button>
            <Button
              size="sm"
              variant={agentEnabled ? "default" : "secondary"}
              disabled={busy || !agentEnabled}
              onClick={() =>
                set.mutate({
                  key: "features.agentEnabled" as const,
                  enabled: false,
                })
              }
            >
              Turn off
            </Button>
          </div>
        </div>
        <div className="mt-4 flex items-start justify-between gap-6 border-t pt-4">
          <div className="space-y-1 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">
                Auto-classify document chunks
              </span>
            </div>
            <div className="text-muted-foreground">
              When on, the ingest worker calls a lightweight classifier
              after each document is chunked and tags every chunk with
              one of the assessment&rsquo;s active domains (or the
              shared <em>ingested</em> bucket when nothing fits). Best-
              effort: a classifier failure leaves chunks untagged and
              the analysis engine still reads them. Costs a small
              amount of AI tokens per document.
            </div>
            <div className="pt-1 text-xs text-muted-foreground">
              <span className="font-medium">Status:</span>{" "}
              <span
                className={
                  autoClassifyChunks
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-muted-foreground"
                }
              >
                {autoClassifyChunks ? "On" : "Off"}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              size="sm"
              variant={autoClassifyChunks ? "secondary" : "default"}
              disabled={busy || autoClassifyChunks}
              onClick={() =>
                set.mutate({
                  key: "features.autoClassifyChunks" as const,
                  enabled: true,
                })
              }
            >
              Turn on
            </Button>
            <Button
              size="sm"
              variant={autoClassifyChunks ? "default" : "secondary"}
              disabled={busy || !autoClassifyChunks}
              onClick={() =>
                set.mutate({
                  key: "features.autoClassifyChunks" as const,
                  enabled: false,
                })
              }
            >
              Turn off
            </Button>
          </div>
        </div>

        <div className="mt-4 flex items-start justify-between gap-6 border-t pt-4">
          <div className="space-y-1 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">Agent flow diagram</span>
            </div>
            <div className="text-muted-foreground">
              The trace viewer on the assessment runs panel (goal,
              status, step-by-step trajectory, side panel, replay
              scrubber). Sub-feature of the agent harness — when off,
              the diagram hides but agent runs still execute normally.
              Useful when reviewers find the diagram noisy. Defaults
              to on for installs that pre-date this flag.
            </div>
            <div className="pt-1 text-xs text-muted-foreground">
              <span className="font-medium">Status:</span>{" "}
              <span
                className={
                  agentFlowVisible
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-muted-foreground"
                }
              >
                {agentFlowVisible ? "Visible" : "Hidden"}
              </span>
              {!agentEnabled ? (
                <span className="ml-2 italic">
                  · agent feature is off, so the diagram is hidden
                  regardless
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              size="sm"
              variant={agentFlowVisible ? "secondary" : "default"}
              disabled={busy || agentFlowVisible}
              onClick={() =>
                set.mutate({
                  key: "features.agentFlowVisible" as const,
                  enabled: true,
                })
              }
            >
              Show
            </Button>
            <Button
              size="sm"
              variant={agentFlowVisible ? "default" : "secondary"}
              disabled={busy || !agentFlowVisible}
              onClick={() =>
                set.mutate({
                  key: "features.agentFlowVisible" as const,
                  enabled: false,
                })
              }
            >
              Hide
            </Button>
          </div>
        </div>

        <div className="mt-4 flex items-start justify-between gap-6 border-t pt-4">
          <div className="space-y-1 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">Hybrid retrieval</span>
            </div>
            <div className="text-muted-foreground">
              When on, the RAG retriever fuses pgvector cosine search
              with Postgres-native lexical search (`tsvector` +{" "}
              `ts_rank`) via Reciprocal Rank Fusion. Closes the gap on
              exact-string queries — version numbers, error codes,
              file paths, rare acronyms — that pure semantic search
              handles poorly. No new infrastructure; reversible.
              Decision: ADR-0027.
            </div>
            <div className="pt-1 text-xs text-muted-foreground">
              <span className="font-medium">Status:</span>{" "}
              <span
                className={
                  hybridRetrieval
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-muted-foreground"
                }
              >
                {hybridRetrieval ? "On (cosine + lexical)" : "Off (cosine only)"}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              size="sm"
              variant={hybridRetrieval ? "secondary" : "default"}
              disabled={busy || hybridRetrieval}
              onClick={() =>
                set.mutate({
                  key: "features.hybridRetrieval" as const,
                  enabled: true,
                })
              }
            >
              Turn on
            </Button>
            <Button
              size="sm"
              variant={hybridRetrieval ? "default" : "secondary"}
              disabled={busy || !hybridRetrieval}
              onClick={() =>
                set.mutate({
                  key: "features.hybridRetrieval" as const,
                  enabled: false,
                })
              }
            >
              Turn off
            </Button>
          </div>
        </div>

        {set.error ? (
          <div className="pt-2 text-xs text-destructive">
            {set.error.message}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
