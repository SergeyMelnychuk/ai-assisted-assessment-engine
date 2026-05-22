import type {
  PrismaClient,
  Priority,
  QuestionStage,
  QuestionType,
} from "@prisma/client";
import { maybeAdvanceAssessmentStage } from "./assessment-stage";
import { callClaude, parseJsonResponse } from "./ai/router";
import {
  QUESTION_GENERATION_SYSTEM_PROMPT,
  buildQuestionGenerationPrompt,
} from "./ai/prompts/question-generation";
import { retrieve } from "./rag-retriever";

/**
 * Question engine — orchestrates:
 *   1. Seeding baseline questions from knowledge-base templates.
 *   2. Generating AI follow-ups grounded in the assessment's evidence.
 *   3. Per-domain coverage calculation.
 *
 * Kept pure-functional / db-parameterized so the same code can run in
 * either the Next request path OR the background BullMQ worker without
 * pulling in environment-specific deps.
 */

// Shape each QUESTION_TEMPLATE KnowledgeArtifact stores in its `content`.
// Strictly a subset of the Prisma enums so a bad template can't land as
// a broken Question row.
interface TemplateQuestion {
  text: string;
  type: QuestionType;
  priority: Priority;
  options?: string[];
  rationale?: string;
  stage?: QuestionStage;
}

interface TemplateContent {
  domain: string;
  name: string;
  description?: string;
  questions: TemplateQuestion[];
}

/**
 * Load baseline questions for the assessment's active domains from the
 * knowledge base and insert them. Idempotent on repeat calls — we skip
 * any domain that already has template-generated questions for this
 * assessment so users don't get a duplicate list after refreshing.
 */
export async function seedBaselineQuestions(
  db: PrismaClient,
  assessmentId: string,
): Promise<{ created: number; skippedDomains: string[] }> {
  const assessment = await db.assessment.findUnique({
    where: { id: assessmentId },
    select: { activeDomains: true },
  });
  if (!assessment) {
    throw new Error(`Assessment ${assessmentId} not found`);
  }

  const artifacts = await db.knowledgeArtifact.findMany({
    where: {
      artifactType: "QUESTION_TEMPLATE",
      isActive: true,
      domain: { in: assessment.activeDomains },
    },
  });

  if (artifacts.length === 0) {
    return { created: 0, skippedDomains: [] };
  }

  // Skip domains that already hold template-sourced questions. We key on
  // (assessmentId, domain, generatedBy=TEMPLATE) so users can re-run the
  // seed later after adding a new active domain without clobbering.
  const already = await db.question.findMany({
    where: {
      assessmentId,
      generatedBy: "TEMPLATE",
      domain: { in: assessment.activeDomains },
    },
    select: { domain: true },
    distinct: ["domain"],
  });
  const seededDomains = new Set(already.map((q) => q.domain));

  let createdCount = 0;
  const skipped: string[] = [];
  for (let ai = 0; ai < artifacts.length; ai++) {
    const artifact = artifacts[ai];
    if (seededDomains.has(artifact.domain ?? "")) {
      if (artifact.domain) skipped.push(artifact.domain);
      continue;
    }
    const content = artifact.content as unknown as TemplateContent;
    if (!content?.questions?.length) continue;

    const rows = content.questions.map((q, qi) => ({
      assessmentId,
      domain: artifact.domain ?? content.domain,
      questionText: q.text,
      questionType: q.type,
      options: q.options ? (q.options as object) : undefined,
      priority: q.priority,
      dependsOn: [] as string[],
      isAnswered: false,
      generatedBy: "TEMPLATE" as const,
      rationale: q.rationale,
      stage: q.stage ?? ("INTAKE" as QuestionStage),
      // Deterministic order: domain block * 100 + position. Gives AI
      // follow-ups room to slot in with orderIndex in the 10k+ range.
      orderIndex: ai * 100 + qi,
    }));

    await db.question.createMany({ data: rows });
    createdCount += rows.length;
  }

  // First questions in flight → nudge stage forward to QUESTIONING.
  // Runs from request and worker contexts; no session is in scope here
  // so the audit row carries `userId: null` and the trigger string.
  if (createdCount > 0) {
    await maybeAdvanceAssessmentStage(db, assessmentId, "QUESTIONING", {
      trigger: "questions.seeded",
      extra: { created: createdCount },
    });
  }

  return { created: createdCount, skippedDomains: skipped };
}

// ─── Follow-up generation via Claude ─────────────────────────────

const FOLLOW_UP_TARGET = 6;

/**
 * Generate AI follow-up questions grounded in existing evidence. Safe to
 * call repeatedly — we deduplicate against already-stored question text
 * (case-insensitive) so the list doesn't balloon.
 */
export async function generateFollowUpQuestions(
  db: PrismaClient,
  assessmentId: string,
): Promise<{ created: number; tokensUsed?: { input: number; output: number } }> {
  const assessment = await db.assessment.findUnique({
    where: { id: assessmentId },
    include: {
      projectContext: true,
    },
  });
  if (!assessment) throw new Error(`Assessment ${assessmentId} not found`);

  const [existingQs, answeredQs] = await Promise.all([
    db.question.findMany({
      where: { assessmentId },
      select: { questionText: true },
    }),
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
  ]);

  // Ground follow-ups in chunks semantically close to the most recent
  // answers (Phase 3 Week 4, ADR-0007). If the assessment has no
  // answers yet we fall back to the active-domains list as the query,
  // which still gives the retriever something coherent to rank on.
  const recentAnswerText = answeredQs
    .slice(0, 5)
    .map((q) => {
      const a = q.answers[0];
      const ans = a?.answerText ?? JSON.stringify(a?.answerData ?? null);
      return `${q.questionText} ${ans}`;
    })
    .join(" ")
    .trim();
  const followUpQuery =
    recentAnswerText.length > 0
      ? recentAnswerText
      : assessment.activeDomains.join(" ");
  const retrievedChunks = await retrieve(db, {
    assessmentId,
    query: followUpQuery,
    topK: 20,
  });
  const evidence = retrievedChunks.map((c) => ({
    domain: c.domain ?? "",
    content: c.content,
  }));

  if (existingQs.length === 0) {
    // No baseline exists — let the initial seed populate first.
    return { created: 0 };
  }

  const ai = await callClaude({
    system: QUESTION_GENERATION_SYSTEM_PROMPT,
    userContent: buildQuestionGenerationPrompt({
      assessmentMode: assessment.mode,
      activeDomains: assessment.activeDomains,
      projectContext: buildProjectBlurb(assessment.projectContext),
      existingFacts: buildEvidenceBlurb(evidence),
      answeredQuestions: buildAnsweredBlurb(answeredQs),
      targetCount: FOLLOW_UP_TARGET,
    }),
    parseResult: (raw) =>
      parseJsonResponse<{
        questions: Array<{
          domain: string;
          questionText: string;
          questionType: string;
          options?: string[] | null;
          priority: string;
          rationale?: string;
          stage?: string;
        }>;
      }>(raw),
  });

  const existingNorm = new Set(
    existingQs.map((q) => q.questionText.trim().toLowerCase()),
  );

  const toInsert = (ai.result.questions ?? [])
    .map((q) => ({
      ...q,
      questionText: q.questionText?.trim(),
    }))
    .filter((q) => {
      if (!q.questionText) return false;
      if (existingNorm.has(q.questionText.toLowerCase())) return false;
      if (!assessment.activeDomains.includes(q.domain)) return false;
      return true;
    })
    .map((q, idx) => ({
      assessmentId,
      domain: q.domain,
      questionText: q.questionText,
      questionType: mapQuestionType(q.questionType),
      options: q.options ? (q.options as unknown as object) : undefined,
      priority: mapPriority(q.priority),
      dependsOn: [] as string[],
      isAnswered: false,
      generatedBy: "AI" as const,
      rationale: q.rationale,
      stage: mapStage(q.stage),
      // AI questions land after any template seed — 10_000 bands avoid
      // overlap with the baseline orderIndex scheme above.
      orderIndex: 10_000 + Date.now() % 100_000 + idx,
    }));

  if (toInsert.length === 0) return { created: 0, tokensUsed: ai.tokensUsed };

  await db.question.createMany({ data: toInsert });
  await maybeAdvanceAssessmentStage(db, assessmentId, "QUESTIONING", {
    trigger: "questions.followup_generated",
    extra: { created: toInsert.length },
  });
  return { created: toInsert.length, tokensUsed: ai.tokensUsed };
}

// ─── Coverage calculation ────────────────────────────────────────

export interface DomainCoverage {
  domain: string;
  total: number;
  answered: number;
  criticalTotal: number;
  criticalAnswered: number;
  /** 0–1 fraction of questions answered */
  answeredRatio: number;
}

export async function computeCoverage(
  db: PrismaClient,
  assessmentId: string,
): Promise<{
  byDomain: DomainCoverage[];
  overall: Omit<DomainCoverage, "domain">;
}> {
  const assessment = await db.assessment.findUnique({
    where: { id: assessmentId },
    select: { activeDomains: true },
  });
  if (!assessment) throw new Error(`Assessment ${assessmentId} not found`);

  const all = await db.question.findMany({
    where: { assessmentId },
    select: { domain: true, isAnswered: true, priority: true },
  });

  const seed = Object.fromEntries(
    assessment.activeDomains.map((d) => [
      d,
      {
        total: 0,
        answered: 0,
        criticalTotal: 0,
        criticalAnswered: 0,
      },
    ]),
  ) as Record<
    string,
    { total: number; answered: number; criticalTotal: number; criticalAnswered: number }
  >;

  for (const q of all) {
    const bucket = seed[q.domain] ?? {
      total: 0,
      answered: 0,
      criticalTotal: 0,
      criticalAnswered: 0,
    };
    bucket.total += 1;
    if (q.isAnswered) bucket.answered += 1;
    if (q.priority === "CRITICAL") {
      bucket.criticalTotal += 1;
      if (q.isAnswered) bucket.criticalAnswered += 1;
    }
    seed[q.domain] = bucket;
  }

  const byDomain: DomainCoverage[] = Object.entries(seed).map(
    ([domain, b]) => ({
      domain,
      ...b,
      answeredRatio: b.total === 0 ? 0 : b.answered / b.total,
    }),
  );

  const total = byDomain.reduce((a, b) => a + b.total, 0);
  const answered = byDomain.reduce((a, b) => a + b.answered, 0);
  const criticalTotal = byDomain.reduce((a, b) => a + b.criticalTotal, 0);
  const criticalAnswered = byDomain.reduce((a, b) => a + b.criticalAnswered, 0);

  return {
    byDomain: byDomain.sort((a, b) => a.domain.localeCompare(b.domain)),
    overall: {
      total,
      answered,
      criticalTotal,
      criticalAnswered,
      answeredRatio: total === 0 ? 0 : answered / total,
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────

function buildProjectBlurb(
  pc: {
    projectName: string | null;
    description: string | null;
    industry: string | null;
    businessGoals: string | null;
    knownConstraints: string | null;
    cloudProviders: string[];
    platforms: string[];
  } | null,
): string {
  if (!pc) return "(no project context captured yet)";
  const lines: string[] = [];
  if (pc.projectName) lines.push(`Project: ${pc.projectName}`);
  if (pc.industry) lines.push(`Industry: ${pc.industry}`);
  if (pc.description) lines.push(`Description: ${pc.description}`);
  if (pc.businessGoals) lines.push(`Goals: ${pc.businessGoals}`);
  if (pc.knownConstraints) lines.push(`Constraints: ${pc.knownConstraints}`);
  if (pc.cloudProviders.length > 0)
    lines.push(`Cloud: ${pc.cloudProviders.join(", ")}`);
  if (pc.platforms.length > 0)
    lines.push(`Platforms: ${pc.platforms.join(", ")}`);
  return lines.length > 0 ? lines.join("\n") : "(no project context captured yet)";
}

function buildEvidenceBlurb(
  rows: Array<{ domain: string; content: string }>,
): string {
  if (rows.length === 0) return "(no evidence collected yet)";
  // Cap at 40 rows to keep the prompt tight — downstream analysis has
  // full access to the table when it needs more.
  return rows
    .slice(0, 40)
    .map((r) => `[${r.domain}] ${truncate(r.content, 200)}`)
    .join("\n");
}

function buildAnsweredBlurb(
  rows: Array<{
    questionText: string;
    domain: string;
    answers: Array<{ answerText: string | null; answerData: unknown }>;
  }>,
): string {
  if (rows.length === 0) return "(no questions answered yet)";
  return rows
    .slice(0, 40)
    .map((r) => {
      const last = r.answers[0];
      const ans = last?.answerText ?? JSON.stringify(last?.answerData ?? null);
      return `Q [${r.domain}] ${truncate(r.questionText, 160)}\n  A: ${truncate(ans, 200)}`;
    })
    .join("\n");
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// Loose string → enum mapping that tolerates the AI answering in either
// case or the string variant of each enum name.
function mapQuestionType(raw: string): QuestionType {
  const k = raw.trim().toLowerCase().replace(/\s+/g, "_");
  switch (k) {
    case "single_choice":
      return "SINGLE_CHOICE";
    case "multi_choice":
      return "MULTI_CHOICE";
    case "numeric":
      return "NUMERIC";
    case "file_upload":
      return "FILE_UPLOAD";
    case "confirmation":
      return "CONFIRMATION";
    case "free_text":
    default:
      return "FREE_TEXT";
  }
}

function mapPriority(raw: string): Priority {
  const k = raw.trim().toUpperCase();
  if (k === "CRITICAL" || k === "HIGH" || k === "MEDIUM" || k === "LOW") {
    return k;
  }
  return "MEDIUM";
}

function mapStage(raw: string | undefined): QuestionStage {
  const k = (raw ?? "").trim().toLowerCase();
  switch (k) {
    case "intake":
      return "INTAKE";
    case "clarification":
      return "CLARIFICATION";
    case "evidence_request":
      return "EVIDENCE_REQUEST";
    case "follow_up":
    default:
      return "FOLLOW_UP";
  }
}
