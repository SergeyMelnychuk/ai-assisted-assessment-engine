"use client";

import { useState } from "react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { useFeatureFlags } from "@/lib/use-feature-flags";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Renders pending agent credential requests as an inline prompt at the
 * top of the assessment page. Shows up only when there's something
 * actually pending (a paused run waiting on a PAT). Polls the
 * `agentRun.pendingCredentials` query while the user is on the page so
 * a request opened by a teammate also surfaces.
 *
 * Why inline instead of a modal: we don't have a Dialog primitive, and
 * a top-of-page card is more discoverable for a multi-tab user — it
 * also stays out of the way when nothing's pending. The submit is a
 * single mutation that re-runs the harness inline; the page query
 * invalidation cascades show the unblocked run state without a refresh.
 */
export function AgentCredentialPrompt({
  assessmentId,
}: {
  assessmentId: string;
}) {
  const utils = trpc.useUtils();
  // Gate the query on the feature flag so the agent endpoints are never
  // hit when the harness is disabled — that's what was producing the
  // "agentRun.pendingCredentials NOT_FOUND" console noise on pages
  // belonging to assessments where the flag is off.
  const { agentEnabled } = useFeatureFlags();
  const { data: pending } = trpc.agentRun.pendingCredentials.useQuery(
    { assessmentId },
    {
      enabled: agentEnabled,
      refetchInterval: agentEnabled ? 5_000 : false,
      // Belt + suspenders: even if the flag flips off mid-session,
      // don't retry a 404.
      retry: (failures, err) =>
        err.data?.code !== "NOT_FOUND" && failures < 1,
    },
  );

  if (!pending || pending.length === 0) return null;

  return (
    <div className="space-y-3">
      {pending.map((req) => (
        <CredentialPromptCard
          key={req.id}
          request={req}
          onFulfilled={async () => {
            await Promise.all([
              utils.agentRun.pendingCredentials.invalidate({ assessmentId }),
              utils.agentRun.getByAssessment.invalidate({ assessmentId }),
              utils.agentRun.get.invalidate({ id: req.runId }),
            ]);
          }}
        />
      ))}
    </div>
  );
}

type PendingRequest =
  RouterOutputs["agentRun"]["pendingCredentials"][number];

function CredentialPromptCard({
  request,
  onFulfilled,
}: {
  request: PendingRequest;
  onFulfilled: () => Promise<void>;
}) {
  const [secret, setSecret] = useState("");
  const submit = trpc.agentRun.submitCredential.useMutation();

  const spec = request.spec;
  const provider = spec?.provider ?? "external system";
  const label = spec?.label ?? request.scope;
  const description = spec?.description ?? request.reason;
  const docHref = spec?.docHref ?? null;
  const recommendedScopes =
    spec?.recommendedScopes ?? request.requiredScopes;

  return (
    <Card className="border-amber-500/40 bg-amber-500/5">
      <CardHeader>
        <CardTitle className="text-base">
          Agent paused — needs a {provider} credential
        </CardTitle>
        <CardDescription>{request.reason}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (submit.isPending) return;
            await submit.mutateAsync({
              requestId: request.id,
              secret: secret.trim(),
            });
            setSecret("");
            await onFulfilled();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor={`agent-cred-${request.id}`}>{label}</Label>
            <p className="text-xs text-muted-foreground">{description}</p>
            {recommendedScopes.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Recommended scopes: {recommendedScopes.join(", ")}
              </p>
            ) : null}
            {docHref ? (
              <p className="text-xs">
                <a
                  href={docHref}
                  className="underline underline-offset-4"
                  target="_blank"
                  rel="noreferrer"
                >
                  How to mint a fine-grained GitHub PAT →
                </a>
              </p>
            ) : null}
          </div>
          <div className="space-y-1">
            <Input
              id={`agent-cred-${request.id}`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="github_pat_..."
              required
              minLength={10}
              maxLength={2048}
            />
          </div>
          {submit.error ? (
            <p className="text-xs text-destructive" role="alert">
              {submit.error.message}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={submit.isPending || secret.trim().length < 10}
            >
              {submit.isPending ? "Submitting…" : "Provide credential"}
            </Button>
            <span className="text-xs text-muted-foreground">
              The token is encrypted at rest with the engagement vault key.
            </span>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
