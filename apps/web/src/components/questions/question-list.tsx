"use client";

import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useBoundedPolling } from "@/lib/use-bounded-polling";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AnswerForm } from "./answer-form";
import { CoverageBar } from "./coverage-bar";
import { domainLabel as prettyDomain } from "@/lib/domain-labels";

type Filter = "all" | "unanswered" | "answered";

const PRIORITY_RANK: Record<string, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

// `text-foreground` on tinted backgrounds — see badge contrast notes
// in `components/analysis/review-badges.tsx`.
const PRIORITY_CLASS: Record<string, string> = {
  CRITICAL: "border-destructive/40 bg-destructive/10 text-destructive",
  HIGH: "border-amber-500/40 bg-amber-500/10 text-foreground",
  MEDIUM: "border-border bg-muted text-foreground",
  LOW: "border-border bg-muted text-foreground",
};

export function QuestionList({ assessmentId }: { assessmentId: string }) {
  const utils = trpc.useUtils();
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  // Coverage rows double as a domain filter — click a bar to scope the
  // list below. Local state (not URL-based) because this filter is only
  // meaningful on this page and we don't link between views by it.
  const [domainFilter, setDomainFilter] = useState<string | null>(null);
  const toggleDomain = (domain: string) =>
    setDomainFilter((prev) => (prev === domain ? null : domain));

  // Poll every 3s while the list is empty (follow-up worker might still
  // be running), but cap total polling so a failed AI call doesn't
  // leave us requesting forever. Once we've got any question rows we
  // stop — tab focus / manual refresh picks up new follow-ups.
  const refetchInterval = useBoundedPolling<unknown[]>({
    isDone: (d) => Array.isArray(d) && d.length > 0,
    intervalMs: 3_000,
  });
  const questionsQuery = trpc.question.listByAssessment.useQuery(
    { assessmentId },
    { refetchInterval },
  );
  const coverageQuery = trpc.question.getCoverage.useQuery({ assessmentId });

  const generateMutation = trpc.question.generateInitial.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.question.listByAssessment.invalidate({ assessmentId }),
        utils.question.getCoverage.invalidate({ assessmentId }),
      ]);
    },
  });

  const grouped = useMemo(() => {
    const data = questionsQuery.data ?? [];
    const map = new Map<string, typeof data>();
    for (const q of data) {
      if (filter === "unanswered" && q.isAnswered) continue;
      if (filter === "answered" && !q.isAnswered) continue;
      if (domainFilter && q.domain !== domainFilter) continue;
      const list = map.get(q.domain) ?? [];
      list.push(q);
      map.set(q.domain, list);
    }
    // Sort each bucket: priority first, then orderIndex.
    for (const list of map.values()) {
      list.sort(
        (a, b) =>
          (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
          a.orderIndex - b.orderIndex,
      );
    }
    return Array.from(map.entries()).sort((a, b) =>
      prettyDomain(a[0]).localeCompare(prettyDomain(b[0])),
    );
  }, [questionsQuery.data, filter, domainFilter]);

  if (questionsQuery.isLoading || coverageQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (questionsQuery.error) {
    return (
      <p
        role="alert"
        className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        {questionsQuery.error.message}
      </p>
    );
  }

  const total = questionsQuery.data?.length ?? 0;

  // Empty state — prompt the user to seed baseline questions.
  if (total === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">No questions yet</CardTitle>
          <CardDescription>
            Seed the baseline set from the knowledge base for the active
            domains. You can always answer, skip, or re-generate after.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            onClick={() => generateMutation.mutate({ assessmentId })}
            disabled={generateMutation.isPending}
          >
            {generateMutation.isPending
              ? "Generating…"
              : "Generate baseline questions"}
          </Button>
          {generateMutation.error ? (
            <p className="text-xs text-destructive">
              {generateMutation.error.message}
            </p>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  const coverage = coverageQuery.data;

  return (
    <div className="space-y-6">
      {coverage ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Coverage</CardTitle>
            <CardDescription>
              {coverage.overall.answered}/{coverage.overall.total} questions
              answered · critical{" "}
              {coverage.overall.criticalAnswered}/
              {coverage.overall.criticalTotal}
              {" · "}
              <span className="text-xs text-muted-foreground">
                Click a domain to filter the questions below
                {domainFilter ? (
                  <>
                    {" · "}
                    <button
                      type="button"
                      onClick={() => setDomainFilter(null)}
                      className="font-medium text-foreground underline underline-offset-4"
                    >
                      clear filter
                    </button>
                  </>
                ) : null}
              </span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {coverage.byDomain.map((d) => (
              <CoverageBar
                key={d.domain}
                domain={d.domain}
                answered={d.answered}
                total={d.total}
                criticalAnswered={d.criticalAnswered}
                criticalTotal={d.criticalTotal}
                active={domainFilter === d.domain}
                onToggle={toggleDomain}
              />
            ))}
          </CardContent>
        </Card>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2">
          {(["all", "unanswered", "answered"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-md border px-3 py-1 text-xs font-medium ${
                filter === f
                  ? "border-primary bg-primary/5"
                  : "border-input text-muted-foreground hover:bg-muted/40"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => generateMutation.mutate({ assessmentId })}
          disabled={generateMutation.isPending}
        >
          {generateMutation.isPending ? "Re-seeding…" : "Re-seed baseline"}
        </Button>
      </div>

      {grouped.length === 0 ? (
        <p className="rounded-md border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
          Nothing matches this filter.
          {domainFilter ? (
            <>
              {" "}
              <button
                type="button"
                onClick={() => setDomainFilter(null)}
                className="font-medium text-foreground underline underline-offset-4"
              >
                Clear domain filter
              </button>
            </>
          ) : null}
        </p>
      ) : (
        grouped.map(([domain, questions]) => (
          <section key={domain} className="space-y-3">
            <header className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {prettyDomain(domain)}
              </h2>
              <span className="text-xs text-muted-foreground">
                {questions.length} question{questions.length === 1 ? "" : "s"}
              </span>
            </header>
            <div className="space-y-2">
              {questions.map((q) => {
                const latest = q.answers[0];
                const isOpen = openId === q.id;
                return (
                  <Card key={q.id}>
                    <CardHeader className="flex flex-row items-start gap-3 space-y-0">
                      <div className="flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${PRIORITY_CLASS[q.priority] ?? ""}`}
                          >
                            {q.priority}
                          </span>
                          <span className="text-xs uppercase tracking-wide text-muted-foreground">
                            {q.generatedBy === "AI"
                              ? "AI follow-up"
                              : q.generatedBy === "TEMPLATE"
                                ? "Baseline"
                                : "Manual"}
                          </span>
                          {q.isAnswered ? (
                            <span className="inline-flex items-center rounded-full border border-green-500/40 bg-green-500/10 px-2 py-0.5 text-xs font-medium text-foreground">
                              Answered
                            </span>
                          ) : null}
                        </div>
                        <CardTitle className="text-sm leading-snug">
                          {q.questionText}
                        </CardTitle>
                        {q.rationale ? (
                          <CardDescription className="text-xs">
                            Why: {q.rationale}
                          </CardDescription>
                        ) : null}
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setOpenId(isOpen ? null : q.id)}
                      >
                        {isOpen ? "Close" : q.isAnswered ? "Edit" : "Answer"}
                      </Button>
                    </CardHeader>

                    {isOpen ? (
                      <CardContent>
                        <AnswerForm
                          questionId={q.id}
                          assessmentId={assessmentId}
                          questionType={q.questionType}
                          options={
                            Array.isArray(q.options)
                              ? (q.options as string[])
                              : null
                          }
                          initialAnswerText={latest?.answerText}
                          initialAnswerData={latest?.answerData}
                          initialConfidence={latest?.confidenceNote}
                          onAnswered={() => setOpenId(null)}
                          onCancel={() => setOpenId(null)}
                        />
                      </CardContent>
                    ) : latest ? (
                      <CardContent className="space-y-1">
                        <p className="whitespace-pre-wrap text-sm">
                          {latest.answerText ??
                            JSON.stringify(latest.answerData)}
                        </p>
                        {latest.confidenceNote ? (
                          <p className="text-xs italic text-muted-foreground">
                            {latest.confidenceNote}
                          </p>
                        ) : null}
                        <p className="text-xs text-muted-foreground">
                          Answered by{" "}
                          {latest.answeredBy?.name ??
                            latest.answeredBy?.email ??
                            "?"}{" "}
                          ·{" "}
                          {new Date(latest.createdAt).toLocaleString(undefined, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </p>
                      </CardContent>
                    ) : null}
                  </Card>
                );
              })}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
