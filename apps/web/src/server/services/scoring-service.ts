import type { MaturityLevel, PrismaClient } from "@prisma/client";
import { callClaude, parseJsonResponse } from "./ai/router";
import {
  DOMAIN_SCORING_SYSTEM_PROMPT,
  buildPerDomainScoringPrompt,
} from "./ai/prompts/domain-scoring";
import { retrieve, type ChunkResult } from "./rag-retriever";

/**
 * Score the active domains of an assessment.
 *
 * Phase 3 Week 2 (ADR-0002): one Claude call per domain, fanned out with
 * a small concurrency cap. Previously this was a single combined call
 * that could truncate mid-JSON on 8-domain assessments.
 */

interface RawScoringResponse {
  domainScores?: Array<{
    domain?: string;
    score?: number;
    maturityLevel?: string;
    confidence?: number;
    scoringRationale?: string;
  }>;
}

export interface DomainScoringStatus {
  domain: string;
  status: "ok" | "failed";
  tokensUsed?: { input: number; output: number };
  error?: string;
}

export interface ScoringRunResult {
  scored: number;
  skippedLockedDomains?: number;
  tokensUsed?: { input: number; output: number };
  perDomain: DomainScoringStatus[];
}

/** Concurrency cap for per-domain scoring calls. Dropped from 2 → 1
 *  after observing `rate_limit_error` (30,000 input tokens/min on
 *  small-tier Anthropic orgs) when scoring ran right after the
 *  analysis phase: the token bucket was already depleted. Sequential
 *  scoring with a small inter-call delay keeps us under the per-minute
 *  ceiling without any backoff/retry machinery. See ADR-0002. */
export const DOMAIN_SCORING_CONCURRENCY = 1;
/** Minimum gap between scoring calls. The Anthropic small-tier org
 *  rate-limit is 30k input tokens/min; at ~5–10k input tokens per
 *  scoring call we can safely fire one every ~2 seconds. */
export const DOMAIN_SCORING_INTER_CALL_DELAY_MS = 2_000;
/** Per-domain output budget. 1024 fits a single rubric entry comfortably. */
export const DOMAIN_SCORING_MAX_TOKENS = 1024;

export interface DomainScoringCaller {
  (opts: {
    system: string;
    userContent: string;
    maxTokens: number;
    parseResult: (raw: string) => RawScoringResponse;
    /** Pass-through to `callClaude` — opt-in prompt caching (ADR-0012). */
    cacheSystem?: boolean;
    /** Pass-through to `callClaude` — per-call audit row (ADR-0012). */
    audit?: {
      callType: "scoring";
      entityId: string;
      entityType?: string;
    };
  }): Promise<{
    result: RawScoringResponse;
    tokensUsed: { input: number; output: number };
  }>;
}

const defaultScoringCaller: DomainScoringCaller = (opts) =>
  callClaude({
    system: opts.system,
    userContent: opts.userContent,
    parseResult: opts.parseResult,
    maxTokens: opts.maxTokens,
    cacheSystem: opts.cacheSystem,
    audit: opts.audit,
    // Force JSON-only output via assistant-turn prefill — see analysis-engine.
    assistantPrefill: "{",
  });

export async function runDomainScoring(
  db: PrismaClient,
  assessmentId: string,
  callClaudeImpl: DomainScoringCaller = defaultScoringCaller,
  /** Same semantics as `runAnalysis`'s `shouldCancel` — see that file. */
  shouldCancel?: () => Promise<boolean>,
): Promise<ScoringRunResult> {
  const assessment = await db.assessment.findUnique({
    where: { id: assessmentId },
    include: { projectContext: true },
  });
  if (!assessment) throw new Error(`Assessment ${assessmentId} not found`);

  // Evidence selection — Phase 3 Week 4 (ADR-0006/0007). One retrieval
  // per active domain, query = scoring-criteria text for that domain.
  // Replaces the old `take: 80` recent-rows slice so the AI sees
  // rubric-relevant chunks, not just whichever happened to ingest most
  // recently. `rubricByDomain` (the full prompt-ready blocks) is loaded
  // separately; `rubricQueries` below is just the query text.
  const rubricByDomain = await loadRubricByDomain(db);
  const rubricQueries = await loadRubricQueriesByDomain(
    db,
    assessment.activeDomains,
  );
  const perDomainTopK = 10;
  const retrievalBudget = Math.min(
    80,
    perDomainTopK * Math.max(1, assessment.activeDomains.length),
  );

  const perDomainChunks = await Promise.all(
    assessment.activeDomains.map((domain) =>
      retrieve(db, {
        assessmentId,
        query: rubricQueries.get(domain) ?? domain,
        domain,
        topK: perDomainTopK,
      }),
    ),
  );

  const seenIds = new Set<string>();
  const chunks: ChunkResult[] = [];
  for (const list of perDomainChunks) {
    for (const c of list) {
      if (seenIds.has(c.evidenceId)) continue;
      seenIds.add(c.evidenceId);
      chunks.push(c);
      if (chunks.length >= retrievalBudget) break;
    }
    if (chunks.length >= retrievalBudget) break;
  }

  const evidenceTask =
    chunks.length > 0
      ? db.evidence.findMany({
          where: { id: { in: chunks.map((c) => c.evidenceId) } },
          select: { id: true, domain: true, content: true, confidence: true },
        })
      : Promise.resolve(
          [] as Array<{ id: string; domain: string; content: string; confidence: number }>,
        );

  const [evidence, answeredQs, findings] = await Promise.all([
    evidenceTask,
    db.question.findMany({
      where: { assessmentId, isAnswered: true },
      include: {
        answers: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { answerText: true, answerData: true },
        },
      },
    }),
    db.finding.findMany({
      where: { assessmentId },
      select: {
        domain: true,
        findingType: true,
        title: true,
        severity: true,
        confidence: true,
      },
    }),
  ]);

  const projectBlurb = buildProjectBlurb(assessment.projectContext);
  const activeDomains = assessment.activeDomains;

  // Week 7 (ADR-0011): remember what the retriever gave each domain so
  // the persisted DomainScore row records the full context, not just
  // the AI's selection.
  const retrievedIdsByDomain = new Map<string, string[]>();
  assessment.activeDomains.forEach((domain, idx) => {
    retrievedIdsByDomain.set(
      domain,
      (perDomainChunks[idx] ?? []).map((c) => c.evidenceId),
    );
  });

  // Track the first domain so we can skip the pre-call delay for it —
  // the delay matters between consecutive calls, not before the very
  // first one. With concurrency=1 the worker pool processes domains
  // sequentially so this is well-defined.
  let domainIdx = 0;
  const perDomainResults = await runWithConcurrency(
    activeDomains,
    DOMAIN_SCORING_CONCURRENCY,
    async (domain): Promise<
      | {
          kind: "ok";
          domain: string;
          parsed: {
            domain: string;
            score: number;
            maturityLevel: MaturityLevel;
            confidence: number;
            scoringRationale: string | null;
            retrievedEvidenceIds: string[];
          } | null;
          tokensUsed: { input: number; output: number };
        }
      | { kind: "failed"; domain: string; error: string }
    > => {
      const domainRubric =
        rubricByDomain.get(domain) ?? `${domain}: (no rubric found)`;
      const domainEvidence = evidence.filter(
        (e) => e.domain === domain || e.domain === "ingested",
      );
      const domainAnswered = answeredQs.filter((q) => q.domain === domain);
      const domainFindings = findings.filter((f) => f.domain === domain);

      // Pace consecutive calls so we stay under the Anthropic org
      // input-token-per-minute bucket. The first call fires
      // immediately; every subsequent call waits the configured
      // inter-call delay. Runs inside the per-domain task so a failure
      // on an earlier domain doesn't stall the pipeline.
      const thisIdx = domainIdx++;
      if (thisIdx > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, DOMAIN_SCORING_INTER_CALL_DELAY_MS),
        );
      }

      // See `runAnalysis` — same short-circuit when the user hits
      // Cancel. A cancelled scoring domain is reported as `failed`
      // with a marker error so the orchestrator can treat the run as
      // cancelled (not faulted).
      if (shouldCancel && (await shouldCancel())) {
        return { kind: "failed" as const, domain, error: "cancelled" };
      }

      try {
        const ai = await callClaudeImpl({
          system: DOMAIN_SCORING_SYSTEM_PROMPT,
          userContent: buildPerDomainScoringPrompt({
            domain,
            assessmentMode: assessment.mode,
            rubric: domainRubric,
            projectContext: projectBlurb,
            evidences: buildEvidenceBlurb(domainEvidence),
            answeredQuestions: buildAnsweredBlurb(domainAnswered),
            findings: buildFindingsBlurb(domainFindings),
          }),
          parseResult: (raw) => parseJsonResponse<RawScoringResponse>(raw),
          maxTokens: DOMAIN_SCORING_MAX_TOKENS,
          // ADR-0012: the scoring system prompt is identical across all
          // domains. Cache it and log per-call cost so the admin cost
          // dashboard attributes scoring correctly.
          cacheSystem: true,
          audit: {
            callType: "scoring",
            entityId: assessmentId,
            entityType: "Assessment",
          },
        });

        // Expect exactly one entry for the requested domain; tolerate
        // the model returning an extra row by filtering to our domain.
        const match = (ai.result.domainScores ?? []).find(
          (s) => s.domain === domain,
        );
        if (!match) {
          return {
            kind: "ok",
            domain,
            parsed: null,
            tokensUsed: ai.tokensUsed,
          };
        }
        return {
          kind: "ok",
          domain,
          parsed: {
            domain,
            score: clampScore(match.score),
            maturityLevel: mapMaturity(match.maturityLevel, match.score),
            confidence: clamp01(match.confidence),
            scoringRationale: match.scoringRationale?.slice(0, 4000) ?? null,
            retrievedEvidenceIds: retrievedIdsByDomain.get(domain) ?? [],
          },
          tokensUsed: ai.tokensUsed,
        };
      } catch (err) {
        return {
          kind: "failed",
          domain,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  const perDomain: DomainScoringStatus[] = [];
  const cleaned: Array<{
    domain: string;
    score: number;
    maturityLevel: MaturityLevel;
    confidence: number;
    scoringRationale: string | null;
    retrievedEvidenceIds: string[];
  }> = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const res of perDomainResults) {
    if (res.kind === "failed") {
      perDomain.push({ domain: res.domain, status: "failed", error: res.error });
      continue;
    }
    totalInputTokens += res.tokensUsed.input;
    totalOutputTokens += res.tokensUsed.output;
    perDomain.push({
      domain: res.domain,
      status: "ok",
      tokensUsed: res.tokensUsed,
    });
    if (res.parsed) cleaned.push(res.parsed);
  }

  if (cleaned.length === 0) {
    return {
      scored: 0,
      tokensUsed:
        totalInputTokens || totalOutputTokens
          ? { input: totalInputTokens, output: totalOutputTokens }
          : undefined,
      perDomain,
    };
  }

  // Partition so we never overwrite a reviewed score. Three cases per
  // domain:
  //   - no row            → create
  //   - row w/ reviewStatus=DRAFT → update
  //   - row w/ any other review status → skip (locked by reviewer)
  const existing = await db.domainScore.findMany({
    where: { assessmentId, domain: { in: cleaned.map((c) => c.domain) } },
    select: { domain: true, reviewStatus: true },
  });
  const existingByDomain = new Map(existing.map((e) => [e.domain, e.reviewStatus]));

  const creates: typeof cleaned = [];
  const updates: typeof cleaned = [];
  let skipped = 0;
  for (const s of cleaned) {
    const prior = existingByDomain.get(s.domain);
    if (!prior) {
      creates.push(s);
    } else if (prior === "DRAFT") {
      updates.push(s);
    } else {
      skipped += 1;
    }
  }

  await db.$transaction([
    ...(creates.length
      ? [
          db.domainScore.createMany({
            data: creates.map((s) => ({
              assessmentId,
              domain: s.domain,
              score: s.score,
              maturityLevel: s.maturityLevel,
              confidence: s.confidence,
              scoringRationale: s.scoringRationale,
              retrievedEvidenceIds: s.retrievedEvidenceIds,
            })),
          }),
        ]
      : []),
    ...updates.map((s) =>
      db.domainScore.update({
        where: {
          assessmentId_domain: {
            assessmentId,
            domain: s.domain,
          },
        },
        data: {
          score: s.score,
          maturityLevel: s.maturityLevel,
          confidence: s.confidence,
          scoringRationale: s.scoringRationale,
          retrievedEvidenceIds: s.retrievedEvidenceIds,
        },
      }),
    ),
  ]);

  return {
    scored: creates.length + updates.length,
    tokensUsed:
      totalInputTokens || totalOutputTokens
        ? { input: totalInputTokens, output: totalOutputTokens }
        : undefined,
    perDomain,
    ...(skipped > 0 ? { skippedLockedDomains: skipped } : {}),
  };
}

// ─── Rubric loading ──────────────────────────────────────────────

/**
 * Build a map of `domainKey → rubric block` from the FRAMEWORK artifacts.
 * Per-domain callers pluck their block out by key; the combined
 * (legacy) path can still join them with `\n\n`.
 */
async function loadRubricByDomain(
  db: PrismaClient,
): Promise<Map<string, string>> {
  const frameworks = await db.knowledgeArtifact.findMany({
    where: { artifactType: "FRAMEWORK", isActive: true },
    select: { name: true, content: true },
  });

  const rubricByDomain = new Map<string, string>();
  for (const f of frameworks) {
    const content = f.content as
      | { domains?: Array<{ key?: string; name?: string; scoringCriteria?: Array<{ level: number; description: string }> }> }
      | null;
    for (const d of content?.domains ?? []) {
      if (!d.key || rubricByDomain.has(d.key)) continue;
      const lines = (d.scoringCriteria ?? [])
        .map((c) => `  L${c.level}: ${c.description}`)
        .join("\n");
      rubricByDomain.set(
        d.key,
        `${d.key} (${d.name ?? d.key}):\n${lines}`,
      );
    }
  }
  return rubricByDomain;
}

/**
 * Bounded-concurrency worker pool — preserves input order. Duplicated
 * from analysis-engine.ts to keep the two services independent; a
 * shared helper would need a module neither already imports.
 */
async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers: Array<Promise<void>> = [];
  const workerCount = Math.min(Math.max(1, limit), items.length);
  for (let w = 0; w < workerCount; w += 1) {
    workers.push(
      (async () => {
        while (true) {
          const idx = cursor;
          cursor += 1;
          if (idx >= items.length) return;
          results[idx] = await fn(items[idx]);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

/**
 * Per-domain retrieval query text, keyed by domain key. Used as the
 * retrieval query for each domain (Phase 3 Week 4, ADR-0007). Not the
 * same shape as `loadRubricByDomain` above — that returns the full
 * prompt-ready block; this returns just the concatenated
 * scoring-criteria text, suitable for embedding.
 */
async function loadRubricQueriesByDomain(
  db: PrismaClient,
  activeDomains: string[],
): Promise<Map<string, string>> {
  const frameworks = await db.knowledgeArtifact.findMany({
    where: { artifactType: "FRAMEWORK", isActive: true },
    select: { content: true },
  });
  const map = new Map<string, string>();
  for (const f of frameworks) {
    const content = f.content as
      | {
          domains?: Array<{
            key?: string;
            name?: string;
            scoringCriteria?: Array<{ level: number; description: string }>;
          }>;
        }
      | null;
    for (const d of content?.domains ?? []) {
      if (!d.key || map.has(d.key)) continue;
      const criteriaText = (d.scoringCriteria ?? [])
        .map((c) => c.description)
        .filter((s) => typeof s === "string" && s.length > 0)
        .join(" ");
      const parts = [d.name ?? d.key, criteriaText].filter(Boolean);
      map.set(d.key, parts.join(" — "));
    }
  }
  const out = new Map<string, string>();
  for (const domain of activeDomains) {
    out.set(domain, map.get(domain) ?? domain);
  }
  return out;
}

function buildProjectBlurb(
  pc: {
    projectName: string | null;
    description: string | null;
    industry: string | null;
    businessGoals: string | null;
    complianceRequirements: string[];
  } | null,
): string {
  if (!pc) return "(no project context)";
  const parts: string[] = [];
  if (pc.projectName) parts.push(`Project: ${pc.projectName}`);
  if (pc.industry) parts.push(`Industry: ${pc.industry}`);
  if (pc.description) parts.push(`Description: ${pc.description}`);
  if (pc.businessGoals) parts.push(`Goals: ${pc.businessGoals}`);
  if (pc.complianceRequirements.length)
    parts.push(`Compliance: ${pc.complianceRequirements.join(", ")}`);
  return parts.join("\n") || "(no project context)";
}

function buildEvidenceBlurb(
  rows: Array<{ id: string; domain: string; content: string; confidence: number }>,
): string {
  if (rows.length === 0) return "(no evidence)";
  return rows
    .map(
      (r) =>
        `[id=${r.id} ${r.domain} ${r.confidence.toFixed(2)}] ${truncate(r.content, 200)}`,
    )
    .join("\n");
}

function buildAnsweredBlurb(
  rows: Array<{
    questionText: string;
    domain: string;
    answers: Array<{ answerText: string | null; answerData: unknown }>;
  }>,
): string {
  if (rows.length === 0) return "(no answered questions)";
  return rows
    .slice(0, 40)
    .map((q) => {
      const latest = q.answers[0];
      const ans = latest?.answerText ?? JSON.stringify(latest?.answerData ?? null);
      return `Q [${q.domain}] ${truncate(q.questionText, 140)}\n  A: ${truncate(ans, 200)}`;
    })
    .join("\n");
}

function buildFindingsBlurb(
  rows: Array<{
    domain: string;
    findingType: string;
    title: string;
    severity: string;
    confidence: number;
  }>,
): string {
  if (rows.length === 0) return "(no findings yet)";
  return rows
    .map(
      (f) =>
        `[${f.domain} ${f.findingType} ${f.severity} conf=${f.confidence.toFixed(2)}] ${truncate(f.title, 200)}`,
    )
    .join("\n");
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function clampScore(raw: number | undefined): number {
  const n = Number(raw);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(5, n));
}

function clamp01(raw: number | undefined): number {
  const n = Number(raw);
  if (Number.isNaN(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

/**
 * Map the AI's maturityLevel string back to the Prisma enum. If the model
 * forgot the enum bucket, bucketize from the numeric score using the
 * standard 5-level rubric rounding.
 */
function mapMaturity(
  raw: string | undefined,
  score: number | undefined,
): MaturityLevel {
  const k = (raw ?? "").trim().toUpperCase().replace(/[\s-]/g, "_");
  if (
    k === "AD_HOC" ||
    k === "INITIAL" ||
    k === "DEFINED" ||
    k === "MANAGED" ||
    k === "OPTIMIZED"
  ) {
    return k;
  }
  const s = Number(score);
  if (Number.isNaN(s)) return "AD_HOC";
  if (s < 1.5) return "AD_HOC";
  if (s < 2.5) return "INITIAL";
  if (s < 3.5) return "DEFINED";
  if (s < 4.5) return "MANAGED";
  return "OPTIMIZED";
}
