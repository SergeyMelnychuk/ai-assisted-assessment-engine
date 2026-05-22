"use client";

import { useEffect, useState } from "react";
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

/**
 * Settings tab — renders a tiny form backed by `adminSettings.{get,update}`.
 *
 * Design notes:
 *   - The catalogue of editable keys is defined server-side (see
 *     `admin-settings.ts`). This component just maps the payload to
 *     number inputs; adding a new knob doesn't require touching this
 *     file provided the shape stays `{ key, label, value, min, max,
 *     default, recommended }`.
 *   - Recommendations are generated server-side from the configured
 *     Claude model id so the copy stays accurate if `ANTHROPIC_MODEL`
 *     changes — no hard-coded strings in the client.
 *   - Local dirty-tracking: we stage edits in component state, so the
 *     operator can tweak both fields and click Save once. A dirty
 *     indicator next to the button tells them there's work to flush.
 */

type SettingsPayload = RouterOutputs["adminSettings"]["get"];
type SettingKey = keyof SettingsPayload["settings"];

export function SettingsTab() {
  const query = trpc.adminSettings.get.useQuery();
  const utils = trpc.useUtils();
  const mutation = trpc.adminSettings.update.useMutation({
    // Refetch after every save — cheap (two JSON reads) and gives the
    // UI authoritative state rather than a cached staged value.
    onSuccess: () => utils.adminSettings.get.invalidate(),
  });

  // Draft map: key → staged value. Seeded from the query on first load
  // and whenever a fresh payload arrives (post-save). Tracking only
  // the numeric value (not the whole settings entry) keeps diff checks
  // trivial.
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!query.data) return;
    const seed: Record<string, number> = {};
    for (const k of Object.keys(query.data.settings) as SettingKey[]) {
      seed[k] = query.data.settings[k].value;
    }
    setDrafts(seed);
  }, [query.data]);

  if (query.isLoading || !query.data) {
    return (
      <div className="text-sm text-muted-foreground">Loading settings…</div>
    );
  }
  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        Failed to load settings: {query.error.message}
      </div>
    );
  }

  const payload = query.data;
  const entries = Object.values(payload.settings);
  const isDirty = entries.some(
    (e) => drafts[e.key] !== undefined && drafts[e.key] !== e.value,
  );

  async function onSaveAll() {
    setErrors({});
    const dirtyEntries = entries.filter(
      (e) => drafts[e.key] !== undefined && drafts[e.key] !== e.value,
    );
    // Sequential rather than parallel: two writes, each invalidates the
    // server-side cache; serial is the conservative choice and the
    // mutation is cheap. If this ever grows to > 5 fields, batch.
    for (const e of dirtyEntries) {
      try {
        await mutation.mutateAsync({
          key: e.key,
          value: drafts[e.key],
         // zod discriminated union on the server — `key` drives the
         // `value` type check there.
        } as never);
      } catch (err) {
        setErrors((cur) => ({
          ...cur,
          [e.key]: err instanceof Error ? err.message : String(err),
        }));
      }
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reference model</CardTitle>
          <CardDescription>
            The recommendation below is derived from this model&apos;s
            rate-limit tier. These throttle knobs apply to{" "}
            <strong>every</strong> provider the router may select for
            <code className="mx-1">analysis.synthesis</code> — a call
            that fails over to Bedrock or OpenAI still occupies one
            concurrency slot. Change the reference via{" "}
            <code>ANTHROPIC_MODEL</code> in the web env.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <code className="text-sm">{payload.model.id}</code>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recommendation</CardTitle>
          <CardDescription>
            Generated from the reference model&apos;s tier + ITPM. Treat
            as guidance, not a hard limit. When the primary provider for
            analysis stops being Anthropic, this panel should re-derive
            from the effective binding — not yet implemented.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>{payload.recommendation.rationale}</p>
          <p className="text-muted-foreground">
            Suggested: concurrency = {payload.recommendation.concurrency},
            inter-call delay = {payload.recommendation.interCallDelayMs} ms
          </p>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {entries.map((e) => (
          <Card key={e.key}>
            <CardHeader>
              <CardTitle className="text-base">{e.label}</CardTitle>
              <CardDescription>{e.description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor={`setting-${e.key}`}>
                  Value (allowed {e.min}–{e.max}, default {e.default})
                </Label>
                <Input
                  id={`setting-${e.key}`}
                  type="number"
                  min={e.min}
                  max={e.max}
                  step={1}
                  value={drafts[e.key] ?? e.value}
                  onChange={(ev) => {
                    const n = Number(ev.target.value);
                    setDrafts((cur) => ({
                      ...cur,
                      [e.key]: Number.isFinite(n) ? n : e.value,
                    }));
                  }}
                  className="w-32"
                />
                {errors[e.key] ? (
                  <p className="text-xs text-destructive">{errors[e.key]}</p>
                ) : null}
              </div>
              <div className="text-xs text-muted-foreground">
                Recommended for current model:{" "}
                <span className="font-medium">{e.recommended}</span>
                {drafts[e.key] !== undefined &&
                drafts[e.key] !== e.recommended ? (
                  <>
                    {" "}
                    ·{" "}
                    <button
                      type="button"
                      className="underline hover:text-foreground"
                      onClick={() =>
                        setDrafts((cur) => ({ ...cur, [e.key]: e.recommended }))
                      }
                    >
                      apply recommended
                    </button>
                  </>
                ) : null}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <Button
          type="button"
          onClick={onSaveAll}
          disabled={!isDirty || mutation.isPending}
        >
          {mutation.isPending ? "Saving…" : "Save"}
        </Button>
        {isDirty ? (
          <span className="text-xs text-muted-foreground">
            Unsaved changes — takes effect on the next assessment run.
          </span>
        ) : null}
      </div>
    </div>
  );
}
