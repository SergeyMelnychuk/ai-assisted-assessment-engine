import type {
  Likelihood,
  Priority,
  PrismaClient,
  Severity,
  FindingType,
  AssumptionSource,
} from "@prisma/client";
import { callClaude, parseJsonResponse } from "./ai/router";
import { classifyProcessingError } from "./ai/error-classifier";
import { log } from "@/server/lib/logger";
import {
  FINDING_GENERATION_SYSTEM_PROMPT,
  buildPerDomainFindingPrompt,
} from "./ai/prompts/finding-generation";
import {
  ANALYSIS_VERIFICATION_MAX_TOKENS,
  ANALYSIS_VERIFICATION_SYSTEM_PROMPT,
  buildAnalysisVerificationPrompt,
} from "./ai/prompts/analysis-verification";
import { retrieve, type ChunkResult } from "./rag-retriever";
import { TOP_K_ANALYSIS } from "./retrieval/retrieval-config";
import {
  DEFAULT_ANALYSIS_MODE,
  type AnalysisMode,
} from "./analysis-mode";
import { getSetting, SETTING_KEYS } from "./settings-service";

/**
 * Analysis engine — consumes the evidence the earlier tasks captured
 * (documents, diagrams, answers) plus knowledge-base risk patterns and
 * produces Findings + Risks + Recommendations + Assumptions.
 *
 * Phase 3 Week 2 (ADR-0002): fans out one Claude call per active domain
 * instead of one combined call. Each domain succeeds or fails
 * independently — siblings are unaffected by one domain's 529/malformed
 * output. See `docs/architecture/decisions/0002-per-domain-analysis-fan-out.md`.
 */

// Raw shape of the Claude JSON response. Everything optional here — the
// mapping functions below coerce enums and clamp numerics so a malformed
// field can't land a broken row in the DB.
interface RawAnalysisResponse {
  findings?: Array<{
    domain?: string;
    findingType?: string;
    title?: string;
    description?: string;
    evidenceIds?: string[];
    confidence?: number;
    severity?: string;
  }>;
  risks?: Array<{
    title?: string;
    category?: string;
    description?: string;
    evidenceIds?: string[];
    impact?: string;
    likelihood?: string;
    severity?: string;
    mitigationProposal?: string;
    ownerSuggestion?: string;
    confidence?: number;
  }>;
  recommendations?: Array<{
    domain?: string;
    title?: string;
    description?: string;
    priority?: string;
    effortIndication?: string;
    relatedRiskIds?: string[];
    confidence?: number;
  }>;
  assumptions?: Array<{
    assumptionText?: string;
    impactIfWrong?: string;
    source?: string;
    confidence?: number;
  }>;
}

interface RawAnalysisVerificationResponse {
  findings?: RawAnalysisResponse["findings"];
  risks?: RawAnalysisResponse["risks"];
  recommendations?: RawAnalysisResponse["recommendations"];
  assumptions?: RawAnalysisResponse["assumptions"];
}

export interface DomainAnalysisStatus {
  domain: string;
  status: "ok" | "failed";
  /** Verifier leg outcome. `null` / absent when no verifier pass ran
   *  (FAST mode, or the analysis phase itself failed before reaching
   *  the verifier). `"ok"` / `"failed"` distinguishes a successful
   *  review from a verifier-threw fallback where generator output was
   *  kept (ADR-0013). Surfaced in the per-domain badge as a third leg
   *  for Reviewed runs only. */
  verify?: "ok" | "failed" | null;
  findings: number;
  risks: number;
  recommendations: number;
  assumptions: number;
  tokensUsed?: { input: number; output: number };
  error?: string;
}

export interface AnalysisRunResult {
  findingsCreated: number;
  risksCreated: number;
  recommendationsCreated: number;
  assumptionsCreated: number;
  tokensUsed?: { input: number; output: number };
  /** Per-domain status — populated by the per-domain fan-out path. */
  perDomain: DomainAnalysisStatus[];
}

/** Concurrency cap for per-domain Claude calls. Dropped from 2 → 1
 *  after observing `rate_limit_error` 429s from Anthropic's 30k
 *  input-tokens-per-minute small-tier org ceiling. Each per-domain
 *  analysis prompt can be 5–15k input tokens (evidence + rubric +
 *  system); two in flight blew the bucket. Sequential with a short
 *  inter-call delay fits comfortably. See ADR-0002. */
export const DOMAIN_ANALYSIS_CONCURRENCY = 1;
/** Gap between consecutive per-domain analysis calls. Dropped from
 *  2000 → 0 ms on 2026-04-19. The delay was cargo-culted from the
 *  `concurrency = 2` era where it spaced the bursts; at concurrency=1
 *  each call already takes 30–60 s of Claude round-trip, so an
 *  additional 2 s between calls was pure idle time (~14 s wasted per
 *  8-domain run) that did nothing for ITPM headroom — ITPM is measured
 *  over a rolling minute, not per-request. Saves ~30 s of wall time
 *  per run for zero downside. If concurrency ever goes back above 1,
 *  reintroduce a non-zero delay here. See ADR-0002. */
export const DOMAIN_ANALYSIS_INTER_CALL_DELAY_MS = 0;
/** Per-domain output budget. Originally 4096, raised to 8192 after we
 *  observed real-world truncations on richer documents: the model would
 *  emit a multi-paragraph markdown preamble + then start the JSON and
 *  run out of budget mid-object. The tightened system prompt (see
 *  `finding-generation.ts`) forbids the preamble, but we keep the
 *  doubled ceiling as insurance — an over-long but complete response
 *  parses; a truncated one is discarded. See ADR-0002. */
export const DOMAIN_ANALYSIS_MAX_TOKENS = 8192;

/** Clamp ranges for the runtime-editable equivalents. The UI enforces
 *  the same bounds, but the engine re-clamps server-side so a direct
 *  tRPC call or a manually-edited Setting row can't drive the worker
 *  pool to a pathological value. Concurrency >8 risks 429s from
 *  Anthropic's ITPM ceiling regardless of tier; delay >30 s would
 *  balloon an 8-domain run's wall time past the job timeout. */
const CONCURRENCY_MIN = 1;
const CONCURRENCY_MAX = 8;
const INTER_CALL_DELAY_MIN_MS = 0;
const INTER_CALL_DELAY_MAX_MS = 30_000;

/** Resolve the runtime-effective per-domain concurrency for this run.
 *  Reads the `analysis.domainConcurrency` Setting (cached 10 s) and
 *  clamps to [1, 8]; falls back to the compiled-in default when the
 *  row is absent. Called from the worker on each assessment — picking
 *  up an admin's change on the next run without a restart. */
export async function resolveDomainAnalysisConcurrency(
  db: PrismaClient,
): Promise<number> {
  const raw = await getSetting<number>(
    db,
    SETTING_KEYS.analysisDomainConcurrency,
    DOMAIN_ANALYSIS_CONCURRENCY,
  );
  const n = Number(raw);
  if (!Number.isFinite(n)) return DOMAIN_ANALYSIS_CONCURRENCY;
  return Math.max(CONCURRENCY_MIN, Math.min(CONCURRENCY_MAX, Math.floor(n)));
}

/** Same contract as `resolveDomainAnalysisConcurrency` for the
 *  inter-call pacing delay, clamped to [0, 30000] ms. */
export async function resolveDomainAnalysisInterCallDelayMs(
  db: PrismaClient,
): Promise<number> {
  const raw = await getSetting<number>(
    db,
    SETTING_KEYS.analysisInterCallDelayMs,
    DOMAIN_ANALYSIS_INTER_CALL_DELAY_MS,
  );
  const n = Number(raw);
  if (!Number.isFinite(n)) return DOMAIN_ANALYSIS_INTER_CALL_DELAY_MS;
  return Math.max(
    INTER_CALL_DELAY_MIN_MS,
    Math.min(INTER_CALL_DELAY_MAX_MS, Math.floor(n)),
  );
}

/**
 * Test-only hook. The dispatch loop calls `callClaudePerDomain` rather
 * than `callClaude` directly so unit tests can override it without
 * mocking the whole SDK surface.
 */
export interface DomainClaudeCaller {
  (opts: {
    system: string;
    userContent: string;
    maxTokens: number;
    parseResult: (raw: string) => RawAnalysisResponse;
    /** Pass-through to `callClaude` — opt-in prompt caching. */
    cacheSystem?: boolean;
    /** Pass-through to `callClaude` — per-call audit row. */
    audit?: {
      callType: "analysis" | "scoring";
      entityId: string;
      entityType?: string;
    };
  }): Promise<{
    result: RawAnalysisResponse;
    tokensUsed: { input: number; output: number };
  }>;
}

export interface DomainAnalysisVerifier {
  (opts: {
    domain: string;
    assessmentId: string;
    assessmentMode: string;
    projectContext: string;
    evidences: string;
    generated: RawAnalysisResponse;
  }): Promise<{
    result: RawAnalysisResponse;
    tokensUsed: { input: number; output: number };
  }>;
}

/**
 * Run the analysis for a single assessment. Replaces any prior AI-generated
 * output (reviewStatus=DRAFT) so a re-run reflects the freshest evidence;
 * reviewed items (IN_REVIEW/APPROVED/REJECTED/NEEDS_REVISION) are preserved
 * to protect in-flight review work.
 *
 * @param callClaudeImpl — optional injection point for tests. Defaults to
 *   the real Claude client.
 */
export async function runAnalysis(
  db: PrismaClient,
  assessmentId: string,
  callClaudeImpl: DomainClaudeCaller = defaultDomainCaller,
  /**
   * Optional pre-flight check fired before each per-domain Claude call.
   * When it resolves truthy, the fan-out aborts further calls; already-
   * completed domains are still persisted. Used by the worker to honor
   * user cancel requests mid-run. See `services/cancellation.ts`.
   */
  shouldCancel?: () => Promise<boolean>,
  /**
   * Execution mode selected at run-request time (ADR-0013). FAST runs
   * only the generator Claude call per domain; THOROUGH adds the
   * verifier pass. Defaults to FAST so an un-flagged caller gets the
   * cheaper path — callers who want the quality premium must opt in.
   */
  mode: AnalysisMode = DEFAULT_ANALYSIS_MODE,
  /**
   * Optional verifier implementation. Injection point for tests.
   * Production defaults to `defaultAnalysisVerifier` (a second Claude
   * call) when `mode === "THOROUGH"`, and is skipped entirely when
   * `mode === "FAST"`. Earlier iterations selected the verifier by
   * reference-comparing `callClaudeImpl` against `defaultDomainCaller`,
   * which silently flipped to the heuristic fallback the moment
   * anyone wrapped the default for tracing or retries — ADR-0013
   * takes the argument explicitly instead.
   */
  verifierImpl?: DomainAnalysisVerifier,
): Promise<AnalysisRunResult> {
  const assessment = await db.assessment.findUnique({
    where: { id: assessmentId },
    include: {
      projectContext: true,
      assessmentType: true,
    },
  });
  if (!assessment) throw new Error(`Assessment ${assessmentId} not found`);

  // Evidence selection — Phase 3 Week 4 (ADR-0006/0007). For each active
  // domain we embed the domain's scoring-criteria text and retrieve the
  // top-K semantically relevant chunks. Hybrid fallback widens past the
  // domain filter when the corpus is thin. The merged set replaces the
  // old `take: 80` most-recent slice. The result feeds the per-domain
  // fan-out below (ADR-0002) — each domain still gets its own Claude call
  // but now with retrieval-scoped evidence, not a FIFO slice.
  const domainQueries = await loadDomainQueries(db, assessment.activeDomains);
  // Per-domain slice of the total retrieval budget. Named-constant
  // source lives in `retrieval-config.ts` (ADR-0012). The summed budget
  // is still capped at 80 below so an engagement with a lot of active
  // domains can't balloon the prompt.
  const perDomainTopK = TOP_K_ANALYSIS;
  const retrievalBudget = Math.min(80, perDomainTopK * Math.max(1, assessment.activeDomains.length));

  const perDomainChunks = await Promise.all(
    assessment.activeDomains.map((domain) =>
      retrieve(db, {
        assessmentId,
        query: domainQueries.get(domain) ?? domain,
        domain,
        topK: perDomainTopK,
      }),
    ),
  );

  // Merge preserving per-domain relevance order, de-duplicated by
  // evidenceId so the same chunk can't count twice against the budget.
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

  // Re-hydrate the full Evidence rows for the retrieved ids so we can
  // feed the existing prompt-builder (it wants sourceType + confidence).
  const evidence =
    chunks.length > 0
      ? await db.evidence.findMany({
          where: { id: { in: chunks.map((c) => c.evidenceId) } },
        })
      : [];

  const [answeredQs, domainScores, riskPatterns] = await Promise.all([
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
    db.domainScore.findMany({ where: { assessmentId } }),
    db.knowledgeArtifact.findMany({
      where: {
        artifactType: "RISK_PATTERN",
        isActive: true,
        domain: { in: assessment.activeDomains },
      },
      select: { name: true, domain: true, content: true },
    }),
  ]);

  const projectBlurb = buildProjectBlurb(assessment.projectContext);
  const domainScoresBlurb = buildDomainScoresBlurb(domainScores);
  const knownEvidenceIds = new Set(evidence.map((e) => e.id));
  const keepKnownEvidence = (ids: string[] | undefined): string[] =>
    (ids ?? []).filter((id) => knownEvidenceIds.has(id));

  // Per-domain fan-out with bounded concurrency. Promise.allSettled
  // isolates failures so one domain's Claude 529 doesn't kill the other
  // seven — matches ADR-0002's "fail-soft per domain" decision.
  const activeDomains = assessment.activeDomains;
  // Track ordinal so we can pace consecutive calls — see the delay
  // constant above. First domain fires immediately; each subsequent
  // domain waits the inter-call delay before hitting Claude. Keeps us
  // under the org's input-tokens-per-minute ceiling without any
  // backoff/retry machinery.
  let analysisCallIdx = 0;
  // Resolve the runtime-editable knobs once per run. Reading per-domain
  // would hit the 10 s cache in settings-service anyway, but doing it
  // up-front keeps the loop body pure and makes partial-run behaviour
  // obvious: the *same* admin-configured values apply across all 8
  // domains of a single assessment, even if the admin saves a new value
  // mid-run. The *next* assessment picks up the new value.
  const effectiveConcurrency = await resolveDomainAnalysisConcurrency(db);
  const effectiveInterCallDelayMs =
    await resolveDomainAnalysisInterCallDelayMs(db);
  const domainResults = await runWithConcurrency(
    activeDomains,
    effectiveConcurrency,
    async (domain) => {
      const thisIdx = analysisCallIdx++;
      if (thisIdx > 0 && effectiveInterCallDelayMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, effectiveInterCallDelayMs),
        );
      }
      // Abort before firing the next Claude call if the user hit
      // "Cancel". Already-processed domains remain in `domainResults`
      // with their real status; remaining ones get a synthetic failed
      // entry so the aggregator treats them as "not produced" rather
      // than silently absent.
      if (shouldCancel && (await shouldCancel())) {
        return { kind: "failed" as const, domain, error: "cancelled" };
      }
      return runOneDomain({
        db,
        domain,
        assessmentId,
        assessmentMode: assessment.mode,
        mode,
        projectBlurb,
        domainScoresBlurb,
        evidence,
        answeredQs,
        riskPatterns,
        callClaudeImpl,
        // FAST skips the verifier entirely (no extra Claude spend).
        // THOROUGH uses the explicit override if provided (tests do
        // this), otherwise the real second-pass Claude caller.
        verifierImpl:
          mode === "THOROUGH"
            ? (verifierImpl ?? defaultAnalysisVerifier)
            : undefined,
      });
    },
  );

  // Build merged insert lists. Each domain's AI output carries its own
  // findings/risks/etc.; we aggregate before the single DB transaction
  // below. Failures contribute nothing and are logged in `perDomain`.
  const perDomain: DomainAnalysisStatus[] = [];
  // Week 7 (ADR-0011): the retriever already ran one query per domain
  // above. We index the per-domain retrieved ids here so the insert
  // paths below can attach `retrievedEvidenceIds` to every Finding /
  // Risk / Recommendation row without re-running retrieval. "Retrieved"
  // is the full set the model saw; "cited" (on `evidenceIds`) is the
  // subset the model chose — the reviewer UI surfaces both.
  const retrievedIdsByDomain = new Map<string, string[]>();
  assessment.activeDomains.forEach((domain, idx) => {
    retrievedIdsByDomain.set(
      domain,
      (perDomainChunks[idx] ?? []).map((c) => c.evidenceId),
    );
  });

  const findingInserts: Array<{
    assessmentId: string;
    domain: string;
    findingType: FindingType;
    title: string;
    description: string;
    evidenceIds: string[];
    retrievedEvidenceIds: string[];
    confidence: number;
    severity: Severity;
  }> = [];
  const riskInserts: Array<{
    assessmentId: string;
    title: string;
    category: string;
    description: string;
    evidenceIds: string[];
    retrievedEvidenceIds: string[];
    impact: Severity;
    likelihood: Likelihood;
    severity: Severity;
    mitigationProposal: string | null;
    ownerSuggestion: string | null;
    confidence: number;
  }> = [];
  const recommendationInserts: Array<{
    assessmentId: string;
    domain: string;
    title: string;
    description: string;
    priority: Priority;
    effortIndication: string | null;
    evidenceIds: string[];
    retrievedEvidenceIds: string[];
    relatedRiskIds: string[];
    confidence: number;
  }> = [];
  const assumptionInserts: Array<{
    assessmentId: string;
    assumptionText: string;
    impactIfWrong: string | null;
    source: AssumptionSource;
    confidence: number;
    requiresValidation: boolean;
  }> = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const res of domainResults) {
    if (res.kind === "failed") {
      perDomain.push({
        domain: res.domain,
        status: "failed",
        findings: 0,
        risks: 0,
        recommendations: 0,
        assumptions: 0,
        error: res.error,
      });
      continue;
    }
    const raw = res.value.result;
    totalInputTokens += res.value.tokensUsed.input;
    totalOutputTokens += res.value.tokensUsed.output;

    const fCount = (raw.findings ?? []).length;
    const rCount = (raw.risks ?? []).length;
    const recCount = (raw.recommendations ?? []).length;
    const aCount = (raw.assumptions ?? []).length;

    const domainRetrieved = retrievedIdsByDomain.get(res.domain) ?? [];
    for (const f of raw.findings ?? []) {
      if (!f.title || !f.description) continue;
      findingInserts.push({
        assessmentId,
        // Pin the domain to the one we asked about — the model sometimes
        // echoes back a re-cased or adjacent value.
        domain: res.domain,
        findingType: mapFindingType(f.findingType),
        title: f.title.slice(0, 500),
        description: f.description,
        evidenceIds: keepKnownEvidence(f.evidenceIds),
        retrievedEvidenceIds: domainRetrieved,
        confidence: clamp01(f.confidence ?? 0.5),
        severity: mapSeverity(f.severity),
      });
    }
    for (const r of raw.risks ?? []) {
      if (!r.title || !r.description) continue;
      const impact = mapSeverity(r.impact);
      const likelihood = mapLikelihood(r.likelihood);
      const severity = r.severity ? mapSeverity(r.severity) : impact;
      riskInserts.push({
        assessmentId,
        title: r.title.slice(0, 500),
        category: (r.category ?? res.domain).slice(0, 120),
        description: r.description,
        evidenceIds: keepKnownEvidence(r.evidenceIds),
        retrievedEvidenceIds: domainRetrieved,
        impact,
        likelihood,
        severity,
        mitigationProposal: r.mitigationProposal?.slice(0, 4000) ?? null,
        ownerSuggestion: r.ownerSuggestion?.slice(0, 500) ?? null,
        confidence: clamp01(r.confidence ?? 0.5),
      });
    }
    for (const rec of raw.recommendations ?? []) {
      if (!rec.title || !rec.description) continue;
      recommendationInserts.push({
        assessmentId,
        domain: res.domain,
        title: rec.title.slice(0, 500),
        description: rec.description,
        priority: mapPriority(rec.priority),
        effortIndication: rec.effortIndication?.slice(0, 200) ?? null,
        evidenceIds: [] as string[],
        // Week 7 (ADR-0011): Recommendation gets the union of the
        // originating finding's retrieved set — since we can't know
        // which finding the model derived a rec from, we fall back to
        // the domain's full retrieved set. That's still the right
        // bound on "what the model had in context for this domain".
        retrievedEvidenceIds: domainRetrieved,
        relatedRiskIds: [] as string[],
        confidence: clamp01(rec.confidence ?? 0.5),
      });
    }
    for (const a of raw.assumptions ?? []) {
      if (!a.assumptionText) continue;
      assumptionInserts.push({
        assessmentId,
        assumptionText: a.assumptionText.slice(0, 4000),
        impactIfWrong: a.impactIfWrong?.slice(0, 4000) ?? null,
        source: mapAssumptionSource(a.source),
        confidence: clamp01(a.confidence ?? 0.5),
        requiresValidation: true,
      });
    }

    perDomain.push({
      domain: res.domain,
      status: "ok",
      verify: res.verify,
      findings: fCount,
      risks: rCount,
      recommendations: recCount,
      assumptions: aCount,
      tokensUsed: res.value.tokensUsed,
    });
  }

  // Atomically: wipe DRAFT rows → insert fresh AI output. Audit logging
  // is the orchestrator's responsibility now (run-analysis job
  // aggregates per-domain status into a single audit row) — this keeps
  // the service layer composable with partial-success reporting.
  const [findingsCreated, risksCreated, recommendationsCreated, assumptionsCreated] =
    await db.$transaction(async (tx) => {
      await Promise.all([
        tx.finding.deleteMany({
          where: { assessmentId, reviewStatus: "DRAFT" },
        }),
        tx.risk.deleteMany({
          where: { assessmentId, reviewStatus: "DRAFT" },
        }),
        tx.recommendation.deleteMany({
          where: { assessmentId, reviewStatus: "DRAFT" },
        }),
        // Assumptions have no reviewStatus — we treat the `requiresValidation`
        // flag as the soft lock: drop only ones that haven't been vetted.
        tx.assumption.deleteMany({
          where: { assessmentId, requiresValidation: true },
        }),
      ]);

      const f = findingInserts.length
        ? await tx.finding.createMany({ data: findingInserts })
        : { count: 0 };
      const r = riskInserts.length
        ? await tx.risk.createMany({ data: riskInserts })
        : { count: 0 };
      const rec = recommendationInserts.length
        ? await tx.recommendation.createMany({ data: recommendationInserts })
        : { count: 0 };
      const asmpt = assumptionInserts.length
        ? await tx.assumption.createMany({ data: assumptionInserts })
        : { count: 0 };

      return [f.count, r.count, rec.count, asmpt.count] as const;
    });

  return {
    findingsCreated,
    risksCreated,
    recommendationsCreated,
    assumptionsCreated,
    tokensUsed:
      totalInputTokens || totalOutputTokens
        ? { input: totalInputTokens, output: totalOutputTokens }
        : undefined,
    perDomain,
  };
}

// ─── Per-domain dispatch ─────────────────────────────────────────

type DomainOutcome =
  | {
      kind: "ok";
      domain: string;
      value: {
        result: RawAnalysisResponse;
        tokensUsed: { input: number; output: number };
      };
      /** Verifier outcome. `null` in FAST mode (pass was skipped). `"ok"`
       *  when the verifier returned a filtered result. `"failed"` when
       *  the verifier threw and we fell back to the raw generator output
       *  (ADR-0013: best-effort). Surfaced in the per-domain status grid
       *  so Reviewed runs show a third leg (`Verify:…`). */
      verify: "ok" | "failed" | null;
    }
  | { kind: "failed"; domain: string; error: string };

async function runOneDomain(opts: {
  db: PrismaClient;
  domain: string;
  assessmentId: string;
  assessmentMode: string;
  /** FAST / THOROUGH — controls whether the verifier runs. */
  mode: AnalysisMode;
  projectBlurb: string;
  domainScoresBlurb: string;
  evidence: Array<{
    id: string;
    domain: string;
    content: string;
    confidence: number;
    sourceType: string;
  }>;
  answeredQs: Array<{
    questionText: string;
    domain: string;
    answers: Array<{ answerText: string | null; answerData: unknown }>;
  }>;
  riskPatterns: Array<{ name: string; domain: string | null; content: unknown }>;
  callClaudeImpl: DomainClaudeCaller;
  /** Undefined in FAST mode — verifier is skipped entirely. */
  verifierImpl?: DomainAnalysisVerifier;
}): Promise<DomainOutcome> {
  const domainEvidence = opts.evidence.filter(
    (e) => e.domain === opts.domain || e.domain === "ingested",
  );
  const domainAnswered = opts.answeredQs.filter((q) => q.domain === opts.domain);
  const domainRiskPatterns = opts.riskPatterns.filter(
    (p) => p.domain === opts.domain,
  );

  const startedAt = Date.now();
  log.info("domain analysis start", {
    worker: "analysis",
    assessmentId: opts.assessmentId,
    domain: opts.domain,
    mode: opts.mode,
  });
  try {
    const ai = await opts.callClaudeImpl({
      system: FINDING_GENERATION_SYSTEM_PROMPT,
      userContent: buildPerDomainFindingPrompt({
        domain: opts.domain,
        assessmentMode: opts.assessmentMode,
        projectContext: opts.projectBlurb,
        evidences: buildEvidenceBlurb(domainEvidence, domainAnswered),
        domainScores: opts.domainScoresBlurb,
        knowledgeBaseContext: buildRiskPatternsBlurb(domainRiskPatterns),
      }),
      parseResult: (raw) => parseJsonResponse<RawAnalysisResponse>(raw),
      maxTokens: DOMAIN_ANALYSIS_MAX_TOKENS,
      // Prompt caching (ADR-0012). The system prompt is identical across
      // all 8 per-domain calls for an assessment, so the second through
      // eighth calls hit the cache. Per-call audit is enabled here so
      // the `/admin/cost` rollup has per-domain granularity.
      cacheSystem: true,
      audit: {
        callType: "analysis",
        entityId: opts.assessmentId,
        entityType: "Assessment",
      },
    });
    // FAST mode or no verifier wired → skip the second pass entirely
    // (cheaper run, half the Claude calls). `verify: null` tells the
    // orchestrator "no verifier leg to report" so the audit row omits
    // this domain from `details.domains.verify`.
    if (opts.mode !== "THOROUGH" || !opts.verifierImpl) {
      log.info("domain analysis complete", {
        worker: "analysis",
        assessmentId: opts.assessmentId,
        domain: opts.domain,
        verify: null,
        scoring: false,
        durationMs: Date.now() - startedAt,
      });
      return { kind: "ok", domain: opts.domain, value: ai, verify: null };
    }
    let verified = ai;
    let verifyStatus: "ok" | "failed" = "ok";
    try {
      const v = await opts.verifierImpl({
        domain: opts.domain,
        assessmentId: opts.assessmentId,
        assessmentMode: opts.assessmentMode,
        projectContext: opts.projectBlurb,
        evidences: buildEvidenceBlurb(domainEvidence, domainAnswered),
        generated: ai.result,
      });
      verified = {
        result: v.result,
        tokensUsed: {
          input: ai.tokensUsed.input + v.tokensUsed.input,
          output: ai.tokensUsed.output + v.tokensUsed.output,
        },
      };
    } catch (verifierErr) {
      verifyStatus = "failed";
      // Best-effort verifier: a verifier failure must not discard the
      // generator's result or the fan-out architecture's "no correlated
      // failure" invariant breaks. But swallowing silently hides drift
      // — if the verifier starts failing on every domain we want an
      // audit trail. Log + write a distinct audit row; the /admin/usage
      // page (and any future quality dashboard) can surface the rate.
      const msg =
        verifierErr instanceof Error
          ? verifierErr.message
          : String(verifierErr);
      // eslint-disable-next-line no-console
      console.warn(
        `[analysis-engine] verifier failed for domain=${opts.domain} assessment=${opts.assessmentId}: ${msg}`,
      );
      log.warn("domain verifier failed", {
        worker: "analysis",
        assessmentId: opts.assessmentId,
        domain: opts.domain,
        message: msg,
      });
      await opts.db.auditLog
        .create({
          data: {
            action: "ANALYSIS_VERIFIER_FAILED",
            entityType: "Assessment",
            entityId: opts.assessmentId,
            details: {
              domain: opts.domain,
              mode: opts.mode,
              error: msg.slice(0, 500),
            },
          },
        })
        .catch(() => {
          /* best-effort — even the audit write is allowed to fail */
        });
    }
    log.info("domain analysis complete", {
      worker: "analysis",
      assessmentId: opts.assessmentId,
      domain: opts.domain,
      verify: verifyStatus,
      scoring: false,
      durationMs: Date.now() - startedAt,
    });
    return {
      kind: "ok",
      domain: opts.domain,
      value: verified,
      verify: verifyStatus,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const classified = classifyProcessingError(err);
    log.error("domain analysis failed", {
      worker: "analysis",
      assessmentId: opts.assessmentId,
      domain: opts.domain,
      errorCategory: classified.category,
      message,
    });
    return {
      kind: "failed",
      domain: opts.domain,
      error: message,
    };
  }
}

/**
 * Bounded-concurrency worker pool. Preserves input order in the output.
 * Keeps us off an external dep (p-limit) — 20 LOC is cheaper than a
 * supply-chain review.
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

const defaultDomainCaller: DomainClaudeCaller = (opts) =>
  callClaude({
    system: opts.system,
    userContent: opts.userContent,
    parseResult: opts.parseResult,
    maxTokens: opts.maxTokens,
    cacheSystem: opts.cacheSystem,
    audit: opts.audit,
    // Force JSON-only output — the prefill makes it impossible for
    // the model to open with a markdown heading or ```json fence, which
    // was the dominant failure mode before Phase 3 Week 2 tail.
    assistantPrefill: "{",
  });

/** Production verifier — second Claude call per domain (ADR-0013).
 *  Tagged with the dedicated `analysis-verify` callType so the
 *  /admin/usage rollup can answer "is the verifier worth its cost?"
 *  without the generator line drowning it out. */
const defaultAnalysisVerifier: DomainAnalysisVerifier = async (opts) =>
  callClaude({
    system: ANALYSIS_VERIFICATION_SYSTEM_PROMPT,
    userContent: buildAnalysisVerificationPrompt({
      domain: opts.domain,
      assessmentMode: opts.assessmentMode,
      projectContext: opts.projectContext,
      evidences: opts.evidences,
      generated: JSON.stringify(opts.generated),
    }),
    parseResult: (raw) =>
      parseJsonResponse<RawAnalysisVerificationResponse>(raw),
    maxTokens: ANALYSIS_VERIFICATION_MAX_TOKENS,
    cacheSystem: true,
    audit: {
      callType: "analysis-verify",
      entityId: opts.assessmentId,
      entityType: "Assessment",
    },
    assistantPrefill: "{",
  });

/**
 * Token-free heuristic verifier — filters the generator's output using
 * the thresholds in `VERIFIER_THRESHOLDS`. Exposed for tests and as a
 * zero-cost alternative callers can opt into in future (e.g. a
 * "CHEAP_VERIFY" mode). Kept as a named export so the evaluation
 * harness can benchmark heuristic-vs-Claude filter quality.
 */
export const heuristicAnalysisVerifier: DomainAnalysisVerifier = async (opts) => ({
  result: locallyVerifyAnalysis(opts.generated),
  tokensUsed: { input: 0, output: 0 },
});

// ─── Prompt construction helpers ────────────────────────────────

function buildProjectBlurb(
  pc: {
    projectName: string | null;
    description: string | null;
    industry: string | null;
    businessGoals: string | null;
    knownConstraints: string | null;
    cloudProviders: string[];
    platforms: string[];
    complianceRequirements: string[];
  } | null,
): string {
  if (!pc) return "(no project context captured)";
  const lines: string[] = [];
  if (pc.projectName) lines.push(`Project: ${pc.projectName}`);
  if (pc.industry) lines.push(`Industry: ${pc.industry}`);
  if (pc.description) lines.push(`Description: ${pc.description}`);
  if (pc.businessGoals) lines.push(`Goals: ${pc.businessGoals}`);
  if (pc.knownConstraints) lines.push(`Constraints: ${pc.knownConstraints}`);
  if (pc.cloudProviders.length) lines.push(`Cloud: ${pc.cloudProviders.join(", ")}`);
  if (pc.platforms.length) lines.push(`Platforms: ${pc.platforms.join(", ")}`);
  if (pc.complianceRequirements.length)
    lines.push(`Compliance: ${pc.complianceRequirements.join(", ")}`);
  return lines.length ? lines.join("\n") : "(no project context captured)";
}

function buildEvidenceBlurb(
  evidence: Array<{
    id: string;
    domain: string;
    content: string;
    confidence: number;
    sourceType: string;
  }>,
  answered: Array<{
    questionText: string;
    domain: string;
    answers: Array<{ answerText: string | null; answerData: unknown }>;
  }>,
): string {
  const evidenceLines = evidence.map(
    (e) =>
      `[id=${e.id} domain=${e.domain} src=${e.sourceType} conf=${e.confidence.toFixed(2)}] ${truncate(e.content, 240)}`,
  );
  const answerLines = answered.slice(0, 40).map((q) => {
    const latest = q.answers[0];
    const ans = latest?.answerText ?? JSON.stringify(latest?.answerData ?? null);
    return `Q [${q.domain}] ${truncate(q.questionText, 160)}\n  A: ${truncate(ans, 240)}`;
  });
  const parts = [
    evidenceLines.length
      ? `--- Evidence rows (${evidenceLines.length}) ---\n${evidenceLines.join("\n")}`
      : "(no evidence for this domain)",
    answerLines.length
      ? `--- Answered questions (${answerLines.length}) ---\n${answerLines.join("\n")}`
      : "(no answered questions for this domain)",
  ];
  return parts.join("\n\n");
}

function buildDomainScoresBlurb(
  scores: Array<{ domain: string; score: number; maturityLevel: string }>,
): string {
  if (scores.length === 0) return "(no prior domain scores)";
  return scores
    .map((s) => `${s.domain}: ${s.score.toFixed(2)} (${s.maturityLevel})`)
    .join("\n");
}

function buildRiskPatternsBlurb(
  patterns: Array<{ name: string; domain: string | null; content: unknown }>,
): string {
  if (patterns.length === 0) return "(no relevant risk patterns loaded)";
  return patterns
    .slice(0, 30)
    .map((p) => {
      const c = p.content as
        | {
            title?: string;
            domain?: string;
            riskTemplate?: { title?: string; description?: string };
          }
        | null;
      const title = c?.riskTemplate?.title ?? c?.title ?? p.name;
      const desc = c?.riskTemplate?.description ?? "";
      return `[${p.domain ?? "generic"}] ${title} — ${truncate(desc, 200)}`;
    })
    .join("\n");
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/**
 * Confidence thresholds used by the heuristic verifier (ADR-0013).
 *
 * The asymmetry across categories is intentional:
 *   - **Findings / risks** have the stricter floors because they feed
 *     both the deliverable narrative and the risk register — a weak
 *     finding surfaces as confident prose to the client. We also
 *     accept *any* confidence if there's at least one evidence id
 *     attached (grounded claim beats a guess).
 *   - **Risks** get a slightly higher floor than findings because a
 *     phantom risk costs the client mitigation effort they don't need,
 *     whereas a phantom finding just wastes a paragraph.
 *   - **Recommendations** get a *lower* floor on purpose: recs are
 *     supposed to include plausible forward-looking suggestions the
 *     evidence alone can't prove (e.g. "consider adopting SLSA"). The
 *     0.4 floor filters lazy boilerplate but not speculative value-adds.
 *   - **Assumptions** survive either by being explicitly grounded
 *     (`source === "evidence_based"`) or by crossing a moderate
 *     confidence bar — assumptions exist precisely to capture "we're
 *     not sure, but…", so over-filtering defeats the point.
 *
 * These numbers are calibration, not law. Tune via the evaluation
 * harness in `analysis-evaluation.ts` when the fixtures expand.
 */
export const VERIFIER_THRESHOLDS = {
  findingConfidenceFloor: 0.7,
  riskConfidenceFloor: 0.75,
  recommendationConfidenceFloor: 0.4,
  assumptionConfidenceFloor: 0.6,
} as const;

function locallyVerifyAnalysis(
  generated: RawAnalysisResponse,
): RawAnalysisResponse {
  const t = VERIFIER_THRESHOLDS;
  return {
    findings: (generated.findings ?? []).filter(
      (f) =>
        Boolean(f.title && f.description) &&
        ((f.evidenceIds?.length ?? 0) > 0 ||
          (f.confidence ?? 0) >= t.findingConfidenceFloor),
    ),
    risks: (generated.risks ?? []).filter(
      (r) =>
        Boolean(r.title && r.description) &&
        ((r.evidenceIds?.length ?? 0) > 0 ||
          (r.confidence ?? 0) >= t.riskConfidenceFloor),
    ),
    recommendations: (generated.recommendations ?? []).filter(
      (r) =>
        Boolean(r.title && r.description) &&
        (r.confidence ?? 0) >= t.recommendationConfidenceFloor,
    ),
    assumptions: (generated.assumptions ?? []).filter(
      (a) =>
        Boolean(a.assumptionText) &&
        (a.source === "evidence_based" ||
          (a.confidence ?? 0) >= t.assumptionConfidenceFloor),
    ),
  };
}

// ─── Retrieval query construction (ADR-0007) ─────────────────────

/**
 * Build the per-domain retrieval query from the FRAMEWORK knowledge
 * artifacts. For each active domain we concatenate the domain name, the
 * human-readable name, and the 5 scoring-criteria descriptions. That
 * string is embedded and used to rank Evidence chunks by cosine
 * similarity — see ADR-0007 for the call-site → query-source matrix.
 *
 * If a domain is missing from the loaded frameworks (e.g. custom
 * activeDomains outside the shipped catalogue), the fallback is the
 * domain key itself. That's deliberately poor — it'll still retrieve
 * something, but the smoke test will catch a corpus-wide regression.
 */
async function loadDomainQueries(
  db: PrismaClient,
  activeDomains: string[],
): Promise<Map<string, string>> {
  const frameworks = await db.knowledgeArtifact.findMany({
    where: { artifactType: "FRAMEWORK", isActive: true },
    select: { content: true },
  });

  const byDomain = new Map<string, string>();
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
      if (!d.key || byDomain.has(d.key)) continue;
      const criteriaText = (d.scoringCriteria ?? [])
        .map((c) => c.description)
        .filter((s) => typeof s === "string" && s.length > 0)
        .join(" ");
      const parts = [d.name ?? d.key, criteriaText].filter(Boolean);
      byDomain.set(d.key, parts.join(" — "));
    }
  }

  const out = new Map<string, string>();
  for (const domain of activeDomains) {
    out.set(domain, byDomain.get(domain) ?? domain);
  }
  return out;
}

// ─── Enum coercion ───────────────────────────────────────────────

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function mapFindingType(raw: string | undefined): FindingType {
  const k = (raw ?? "").trim().toUpperCase();
  if (
    k === "STRENGTH" ||
    k === "WEAKNESS" ||
    k === "GAP" ||
    k === "OBSERVATION" ||
    k === "OPPORTUNITY"
  ) {
    return k;
  }
  return "OBSERVATION";
}

function mapSeverity(raw: string | undefined): Severity {
  const k = (raw ?? "").trim().toUpperCase();
  if (
    k === "CRITICAL" ||
    k === "HIGH" ||
    k === "MEDIUM" ||
    k === "LOW" ||
    k === "INFO"
  ) {
    return k;
  }
  return "MEDIUM";
}

function mapLikelihood(raw: string | undefined): Likelihood {
  const k = (raw ?? "").trim().toUpperCase().replace(/[\s-]/g, "_");
  if (k === "VERY_LIKELY" || k === "LIKELY" || k === "POSSIBLE" || k === "UNLIKELY") {
    return k;
  }
  return "POSSIBLE";
}

function mapPriority(raw: string | undefined): Priority {
  const k = (raw ?? "").trim().toUpperCase();
  if (k === "CRITICAL" || k === "HIGH" || k === "MEDIUM" || k === "LOW") {
    return k;
  }
  return "MEDIUM";
}

function mapAssumptionSource(raw: string | undefined): AssumptionSource {
  const k = (raw ?? "").trim().toUpperCase().replace(/[\s-]/g, "_");
  if (k === "AI_INFERRED" || k === "STAKEHOLDER_STATED" || k === "EVIDENCE_BASED") {
    return k;
  }
  return "AI_INFERRED";
}
