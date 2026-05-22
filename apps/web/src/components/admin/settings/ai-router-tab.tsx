"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  MODEL_SUGGESTIONS,
  TASK_COPY,
  effectiveBindingSentence,
  modelDisplay,
  providerDisplay,
} from "./ai-router-copy";
import { SettingsTab } from "./settings-tab";
import { FeatureFlagsCard } from "./feature-flags-card";

/**
 * AI Router tab — minimal UI over `AiModelOverride` CRUD.
 *
 * Shows one card per task with its current effective binding (override
 * if present, otherwise the ADR-0015 registry default), and a small
 * "Set override" form that upserts provider + model + reason in one
 * click. Fallbacks and `cacheSystem` / `timeoutMs` are deferred to a
 * future iteration — the common admin action is "pin this task to a
 * known-good snapshot" which needs only the primary binding.
 *
 * Operational expectation: overrides are rare and short-lived. The
 * reason field is required so the audit trail explains why this row
 * exists to the person who inherits it three quarters later.
 */

type ListPayload = RouterOutputs["adminAiRouter"]["list"];
type ProviderT = ListPayload["providers"][number];
type TaskT = ListPayload["tasks"][number];
type ProviderStatusT = ListPayload["providerStatus"][number];

interface DraftRow {
  provider: ProviderT;
  model: string;
  reason: string;
}

export function AiRouterTab() {
  const query = trpc.adminAiRouter.list.useQuery();
  const utils = trpc.useUtils();
  const upsert = trpc.adminAiRouter.upsert.useMutation({
    onSuccess: () => utils.adminAiRouter.list.invalidate(),
  });
  const remove = trpc.adminAiRouter.delete.useMutation({
    onSuccess: () => utils.adminAiRouter.list.invalidate(),
  });

  const [drafts, setDrafts] = useState<Record<string, DraftRow>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const overrideByTask = useMemo(() => {
    const m = new Map<TaskT, ListPayload["overrides"][number]>();
    if (query.data) {
      for (const o of query.data.overrides) m.set(o.task as TaskT, o);
    }
    return m;
  }, [query.data]);

  if (query.isLoading || !query.data) {
    return (
      <div className="text-sm text-muted-foreground">Loading router…</div>
    );
  }
  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        Failed to load router state: {query.error.message}
      </div>
    );
  }

  const payload = query.data;
  const statusByProvider = new Map<ProviderT, ProviderStatusT>(
    payload.providerStatus.map((s) => [s.provider as ProviderT, s]),
  );

  function draftFor(task: TaskT): DraftRow {
    const existing = drafts[task];
    if (existing) return existing;
    const override = overrideByTask.get(task);
    const fallback = payload.defaults.find((d) => d.task === task);
    if (override) {
      const b = override.binding as { provider: ProviderT; model: string };
      return { provider: b.provider, model: b.model, reason: override.reason };
    }
    return {
      provider: (fallback?.binding.primary.provider ?? "anthropic") as ProviderT,
      model: fallback?.binding.primary.model ?? "",
      reason: "",
    };
  }

  function setDraft(task: TaskT, patch: Partial<DraftRow>) {
    setDrafts((cur) => ({
      ...cur,
      [task]: { ...draftFor(task), ...patch },
    }));
  }

  async function onSave(task: TaskT) {
    setErrors((cur) => ({ ...cur, [task]: "" }));
    const d = draftFor(task);
    if (!d.model.trim()) {
      setErrors((cur) => ({ ...cur, [task]: "Model id is required" }));
      return;
    }
    const providerStatus = statusByProvider.get(d.provider);
    if (providerStatus && !providerStatus.configured) {
      setErrors((cur) => ({
        ...cur,
        [task]: `${providerDisplay(d.provider)} has no credentials configured. ${providerStatus.note}`,
      }));
      return;
    }
    if (d.reason.trim().length < 3) {
      setErrors((cur) => ({
        ...cur,
        [task]: "Reason must be at least 3 characters (audit trail)",
      }));
      return;
    }
    try {
      await upsert.mutateAsync({
        task,
        binding: { provider: d.provider, model: d.model },
        fallbacks: [],
        reason: d.reason,
      });
      // Clear the draft so the re-fetched override row becomes the
      // displayed state.
      setDrafts((cur) => {
        const next = { ...cur };
        delete next[task];
        return next;
      });
    } catch (err) {
      setErrors((cur) => ({
        ...cur,
        [task]: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  async function onRevert(task: TaskT) {
    setErrors((cur) => ({ ...cur, [task]: "" }));
    try {
      await remove.mutateAsync({ task });
      setDrafts((cur) => {
        const next = { ...cur };
        delete next[task];
        return next;
      });
    } catch (err) {
      setErrors((cur) => ({
        ...cur,
        [task]: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  return (
    <div className="space-y-4">
      <Card className="bg-muted/30">
        <CardHeader>
          <CardTitle className="text-base">How this works</CardTitle>
          {/* Plain <div>, not <CardDescription>: CardDescription
              renders a <p>, and we need block children (paragraphs +
              a link-bearing paragraph) inside. Nesting <p> inside <p>
              is invalid HTML and triggers a React hydration error. */}
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              Each row below is one job the AI engine does during an
              assessment (writing findings, scoring a domain, generating
              a diagram, and so on). Each job is wired to a primary model
              plus an ordered list of automatic fallbacks.
            </p>
            <p>
              If the primary model is down, rate-limited, or times out,
              the engine transparently retries on the next provider in
              the chain — assessments keep running without manual
              intervention. Deterministic errors (wrong API key, content
              filter, invalid model id) are <strong>not</strong> retried,
              because swapping providers wouldn&apos;t fix them.
            </p>
            <p>
              You can pin a specific job to a different provider/model by
              setting an override. Overrides take effect on the next call
              (no redeploy, no restart) and are recorded in the audit log
              with the reason you provide.
            </p>
            <p>
              For the full end-to-end reference — task catalogue, fallback
              chains, decision guide, safety rails, and FAQ — see the{" "}
              <Link
                href="/admin/guides/ai-router"
                className="font-medium text-primary underline-offset-2 hover:underline"
              >
                AI Router guide
              </Link>
              .
            </p>
          </div>
        </CardHeader>
      </Card>

      <FeatureFlagsCard />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Provider credentials</CardTitle>
          <CardDescription className="text-sm">
            Credentials are read from environment variables at call time
            — there is no in-app vault. Providers marked{" "}
            <span className="font-medium text-destructive">
              not configured
            </span>{" "}
            are disabled in the override dropdown because calls to them
            would fail with an auth error. Fix the env and redeploy (or
            restart in dev) to enable them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y text-sm">
            {payload.providerStatus.map((s) => (
              <li
                key={s.provider}
                className="flex items-start justify-between gap-4 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {providerDisplay(s.provider as ProviderT)}
                    </span>
                    {s.configured ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                        Configured
                      </span>
                    ) : (
                      <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-destructive">
                        Not configured
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {s.note}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Env vars
                  </p>
                  <p className="font-mono text-[11px] text-foreground/80">
                    {s.envVars.join(", ")}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {payload.tasks.map((task) => {
        const def = payload.defaults.find((d) => d.task === task);
        const override = overrideByTask.get(task);
        const draft = draftFor(task);
        const effective = override
          ? (override.binding as { provider: ProviderT; model: string })
          : {
              provider: def?.binding.primary.provider as ProviderT,
              model: def?.binding.primary.model ?? "(unknown)",
            };
        const copy = TASK_COPY[task];
        const defaultFallbacks = def?.binding.fallbacks ?? [];
        const effectiveFallbacks = override
          ? (override.fallbacks as unknown as ReadonlyArray<{
              provider: ProviderT;
              model: string;
            }>)
          : defaultFallbacks;
        const bindingSentence = effectiveBindingSentence(
          effective,
          effectiveFallbacks,
        );

        return (
          <Card key={task}>
            <CardHeader>
              <CardTitle className="text-base">
                {copy?.title ?? task}{" "}
                <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
                  {task}
                </span>
              </CardTitle>
              {/* Same reason as above: block children require a <div>
                  wrapper, not <CardDescription> (which is a <p>). */}
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>{copy?.description}</p>
                {override ? (
                  <p className="rounded-md border border-amber-500/40 bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                    <strong>Manual override active.</strong> Reason:{" "}
                    {override.reason}. Click &ldquo;Revert to default&rdquo;
                    below to restore the standard configuration.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Running on the standard configuration — no manual
                    override in effect.
                  </p>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-md border bg-muted/30 p-3 text-sm">
                <p className="text-foreground">{bindingSentence}</p>
                {copy?.operationalNote ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    <strong>Note:</strong> {copy.operationalNote}
                  </p>
                ) : null}
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor={`prov-${task}`}>Provider</Label>
                  <select
                    id={`prov-${task}`}
                    value={draft.provider}
                    onChange={(e) =>
                      setDraft(task, { provider: e.target.value as ProviderT })
                    }
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  >
                    {payload.providers.map((p) => {
                      const s = statusByProvider.get(p);
                      const configured = s?.configured ?? true;
                      return (
                        <option key={p} value={p} disabled={!configured}>
                          {providerDisplay(p)}
                          {configured ? "" : " — not configured"}
                        </option>
                      );
                    })}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`model-${task}`}>Model id</Label>
                  <Input
                    id={`model-${task}`}
                    type="text"
                    value={draft.model}
                    onChange={(e) =>
                      setDraft(task, { model: e.target.value })
                    }
                    list={`models-${task}-${draft.provider}`}
                    autoComplete="off"
                  />
                  {/* Curated suggestions per provider. Free-text input
                      still wins — a just-released snapshot ID can be
                      typed verbatim and the datalist simply won't
                      match it (which is fine). */}
                  <datalist id={`models-${task}-${draft.provider}`}>
                    {(MODEL_SUGGESTIONS[draft.provider] ?? []).map((id) => (
                      <option key={id} value={id}>
                        {modelDisplay(id)}
                      </option>
                    ))}
                  </datalist>
                  <p className="text-[11px] text-muted-foreground">
                    Current: <code>{modelDisplay(effective.model)}</code>
                    {MODEL_SUGGESTIONS[draft.provider]?.length ? (
                      <>
                        {" · "}Type to see{" "}
                        {MODEL_SUGGESTIONS[draft.provider].length} known{" "}
                        {providerDisplay(draft.provider)} models
                      </>
                    ) : null}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`reason-${task}`}>Reason (audit)</Label>
                  <Input
                    id={`reason-${task}`}
                    type="text"
                    placeholder="e.g. pin to known-good snapshot"
                    value={draft.reason}
                    onChange={(e) =>
                      setDraft(task, { reason: e.target.value })
                    }
                  />
                </div>
              </div>

              {errors[task] ? (
                <p className="text-xs text-destructive">{errors[task]}</p>
              ) : null}

              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  onClick={() => onSave(task)}
                  disabled={upsert.isPending}
                  size="sm"
                >
                  {override ? "Update override" : "Set override"}
                </Button>
                {override ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => onRevert(task)}
                    disabled={remove.isPending}
                  >
                    Revert to default
                  </Button>
                ) : null}
              </div>
            </CardContent>
          </Card>
        );
      })}

      {/* Concurrency & pacing — previously its own "Concurrency" tab.
          Moved here because the knobs gate parallelism for
          analysis.synthesis specifically, and belong next to the
          per-task bindings above rather than in a separate tab. The
          storage (Setting rows via adminSettings.update) and pricing
          advisor stay exactly as they were; only the UI location
          changed. */}
      <div className="space-y-2 pt-6">
        <div className="border-t pt-6">
          <h3 className="text-lg font-semibold tracking-tight">
            Concurrency &amp; pacing
          </h3>
          <p className="text-sm text-muted-foreground">
            Global throttle for per-domain analysis calls. Applies
            across all providers — one concurrency pool, shared across
            the fallback chain.
          </p>
        </div>
        <SettingsTab />
      </div>
    </div>
  );
}
