import { Prisma, type PrismaClient, type Seniority } from "@prisma/client";
import { callClaude, parseJsonResponse } from "./ai/router";
import {
  TEAM_ESTIMATION_SYSTEM_PROMPT,
  buildTeamEstimationPrompt,
} from "./ai/prompts/team-estimation";

/**
 * Estimation service — proposes team + effort range + pricing.
 *
 * Two outputs:
 *   - RoleProposal rows (one per role, reviewable individually)
 *   - Estimate row (aggregated totals + rateCardId + raw allocation JSON)
 *
 * Same review-lock discipline as the analysis engine: a re-run wipes only
 * DRAFT rows, keeping any row a reviewer has already touched.
 */

interface RateRow {
  role: string;
  seniority: string;
  hourlyRate: number;
  dailyRate?: number;
}

interface RoleCatalogEntry {
  key: string;
  name: string;
  seniorityRange: string[];
  description?: string;
  typicalResponsibilities?: string[];
  whenNeeded?: string;
}

interface RawRole {
  roleName?: string;
  seniority?: string;
  count?: number;
  hoursLow?: number;
  hoursHigh?: number;
  justification?: string;
  responsibilities?: string;
  phase?: string;
  expertiseRequired?: string[];
}

interface RawEstimationResponse {
  scenarioName?: string;
  confidence?: number;
  assumptions?: string;
  roles?: RawRole[];
}

export interface EstimationRunResult {
  scenarioName: string;
  proposalsCreated: number;
  estimateId: string;
  totalEffortHoursLow: number;
  totalEffortHoursHigh: number;
  totalCostLow: number;
  totalCostHigh: number;
  unmatchedRoles: string[];
  skippedLockedProposals: number;
  tokensUsed?: { input: number; output: number };
}

export async function runEstimation(
  db: PrismaClient,
  assessmentId: string,
): Promise<EstimationRunResult> {
  const assessment = await db.assessment.findUnique({
    where: { id: assessmentId },
    include: { projectContext: true },
  });
  if (!assessment) throw new Error(`Assessment ${assessmentId} not found`);

  // Pull everything the prompt needs in parallel.
  const [
    roleCatalogArtifact,
    rateCard,
    findings,
    risks,
    domainScores,
  ] = await Promise.all([
    db.knowledgeArtifact.findFirst({
      where: {
        artifactType: "ROLE_CATALOG",
        isActive: true,
        name: "role_catalog.standard",
      },
    }),
    // Prefer the default; fall back to whichever is valid-today if no default
    // is flagged. Estimation can't proceed without a rate card.
    db.rateCard.findFirst({
      where: { isDefault: true },
      orderBy: { validFrom: "desc" },
    }),
    db.finding.findMany({
      where: { assessmentId },
      select: {
        domain: true,
        findingType: true,
        severity: true,
        title: true,
      },
      orderBy: { severity: "asc" },
      take: 30,
    }),
    db.risk.findMany({
      where: { assessmentId },
      select: {
        title: true,
        severity: true,
        impact: true,
        likelihood: true,
      },
      orderBy: { severity: "asc" },
      take: 30,
    }),
    db.domainScore.findMany({
      where: { assessmentId },
      select: { domain: true, score: true, maturityLevel: true },
    }),
  ]);

  if (!roleCatalogArtifact) {
    throw new Error(
      "Role catalog not seeded — run `pnpm db:seed` before running estimation",
    );
  }
  if (!rateCard) {
    throw new Error("No rate card configured — cannot price the estimate");
  }

  const catalogContent = roleCatalogArtifact.content as {
    roles?: RoleCatalogEntry[];
  };
  const catalog = catalogContent.roles ?? [];
  const catalogByName = new Map(catalog.map((r) => [r.name, r]));

  const rates = (rateCard.rates as unknown as RateRow[]) ?? [];
  // Lookup table: "Role Name|SENIORITY" → hourlyRate. Used both as a price
  // oracle and to flag "no rate card coverage" for odd picks.
  const rateByKey = new Map<string, number>();
  for (const r of rates) {
    rateByKey.set(`${r.role}|${r.seniority}`, r.hourlyRate);
  }

  const ai = await callClaude({
    system: TEAM_ESTIMATION_SYSTEM_PROMPT,
    userContent: buildTeamEstimationPrompt({
      assessmentMode: assessment.mode,
      activeDomains: assessment.activeDomains,
      projectContext: buildProjectBlurb(assessment.projectContext),
      roleCatalog: buildCatalogBlurb(catalog),
      findings: buildFindingsBlurb(findings),
      risks: buildRisksBlurb(risks),
      domainScores: buildScoresBlurb(domainScores),
    }),
    parseResult: (raw) => parseJsonResponse<RawEstimationResponse>(raw),
    maxTokens: 4_000,
  });

  const unmatched: string[] = [];
  const proposals: Array<{
    roleName: string;
    seniority: Seniority;
    count: number;
    hoursLow: number;
    hoursHigh: number;
    hourlyRate: number;
    justification: string;
    responsibilities: string;
    phase: string | null;
    expertiseRequired: string[];
  }> = [];

  for (const r of ai.result.roles ?? []) {
    const matched = r.roleName ? catalogByName.get(r.roleName) : undefined;
    if (!r.roleName || !matched) {
      if (r.roleName) unmatched.push(r.roleName);
      continue;
    }
    const seniority = coerceSeniority(r.seniority, matched.seniorityRange);
    const count = clampInt(r.count, 1, 50, 1);
    const hoursLow = clampInt(r.hoursLow, 0, 50_000, 40);
    const hoursHigh = Math.max(hoursLow, clampInt(r.hoursHigh, 0, 50_000, hoursLow));
    const hourlyRate = rateByKey.get(`${matched.name}|${seniority}`) ?? 0;
    proposals.push({
      roleName: matched.name,
      seniority,
      count,
      hoursLow,
      hoursHigh,
      hourlyRate,
      justification:
        (r.justification ?? "").slice(0, 4000) ||
        "AI-generated justification missing",
      responsibilities:
        (r.responsibilities ?? matched.typicalResponsibilities?.join("; ") ?? "").slice(0, 4000),
      phase: r.phase?.slice(0, 80) ?? null,
      expertiseRequired: Array.isArray(r.expertiseRequired)
        ? r.expertiseRequired.map((s) => String(s).slice(0, 80)).slice(0, 16)
        : [],
    });
  }

  // Sum up totals. Low = sum(hoursLow * count * rate); high same with hoursHigh.
  let totalLow = 0;
  let totalHigh = 0;
  let costLow = 0;
  let costHigh = 0;
  for (const p of proposals) {
    totalLow += p.hoursLow * p.count;
    totalHigh += p.hoursHigh * p.count;
    costLow += p.hoursLow * p.count * p.hourlyRate;
    costHigh += p.hoursHigh * p.count * p.hourlyRate;
  }

  const scenarioName = (ai.result.scenarioName ?? `AI ${assessment.mode} estimate`).slice(0, 120);
  const assumptions =
    ai.result.assumptions?.slice(0, 4000) ?? "No assumptions returned";
  const confidence = clamp01(ai.result.confidence);

  // Build the full allocation JSON now so the Estimate row has a faithful
  // copy even if individual RoleProposal rows are later edited or deleted.
  const allocationsJson = proposals.map((p) => ({
    roleName: p.roleName,
    seniority: p.seniority,
    count: p.count,
    hoursLow: p.hoursLow,
    hoursHigh: p.hoursHigh,
    hourlyRate: p.hourlyRate,
    phase: p.phase,
    expertiseRequired: p.expertiseRequired,
  }));

  // Atomic replace: drop DRAFT rows, insert fresh, reconcile Estimate.
  const [createdProposals, estimate, skippedLockedProposals] =
    await db.$transaction(async (tx) => {
      const locked = await tx.roleProposal.count({
        where: {
          assessmentId,
          reviewStatus: {
            in: ["IN_REVIEW", "APPROVED", "REJECTED", "NEEDS_REVISION"],
          },
        },
      });
      await tx.roleProposal.deleteMany({
        where: { assessmentId, reviewStatus: "DRAFT" },
      });

      const created = proposals.length
        ? await tx.roleProposal.createMany({
            data: proposals.map((p) => ({
              assessmentId,
              roleName: p.roleName,
              seniority: p.seniority,
              count: p.count,
              justification: p.justification,
              responsibilities: p.responsibilities,
              phase: p.phase,
              expertiseRequired: p.expertiseRequired,
            })),
          })
        : { count: 0 };

      // One Estimate row per run — we replace any existing DRAFT estimate
      // so the numbers track the current proposal set.
      await tx.estimate.deleteMany({
        where: { assessmentId, reviewStatus: "DRAFT" },
      });
      const est = await tx.estimate.create({
        data: {
          assessmentId,
          scenarioName,
          totalEffortHoursLow: totalLow,
          totalEffortHoursHigh: totalHigh,
          totalCostLow: new Prisma.Decimal(costLow.toFixed(2)),
          totalCostHigh: new Prisma.Decimal(costHigh.toFixed(2)),
          rateCardId: rateCard.id,
          roleAllocations: allocationsJson,
          assumptions,
          confidence,
        },
      });

      await tx.auditLog.create({
        data: {
          action: "RUN_ESTIMATION",
          entityType: "Assessment",
          entityId: assessmentId,
          details: {
            proposals: created.count,
            totalEffortHoursLow: totalLow,
            totalEffortHoursHigh: totalHigh,
            totalCostLow: costLow,
            totalCostHigh: costHigh,
            rateCardId: rateCard.id,
            unmatchedRoles: unmatched,
            tokens: ai.tokensUsed,
          },
        },
      });

      return [created.count, est, locked] as const;
    });

  return {
    scenarioName,
    proposalsCreated: createdProposals,
    estimateId: estimate.id,
    totalEffortHoursLow: totalLow,
    totalEffortHoursHigh: totalHigh,
    totalCostLow: costLow,
    totalCostHigh: costHigh,
    unmatchedRoles: unmatched,
    skippedLockedProposals,
    tokensUsed: ai.tokensUsed,
  };
}

// ─── Prompt-builder helpers ─────────────────────────────────────

function buildProjectBlurb(
  pc: {
    projectName: string | null;
    description: string | null;
    industry: string | null;
    businessGoals: string | null;
    knownConstraints: string | null;
    expectedTimeline: string | null;
    estimatedUsers: string | null;
    budgetSensitivity: string | null;
    cloudProviders: string[];
    platforms: string[];
    complianceRequirements: string[];
    isGreenfield: boolean;
  } | null,
): string {
  if (!pc) return "(no project context captured)";
  const lines: string[] = [];
  if (pc.projectName) lines.push(`Project: ${pc.projectName}`);
  if (pc.industry) lines.push(`Industry: ${pc.industry}`);
  if (pc.description) lines.push(`Description: ${pc.description}`);
  if (pc.businessGoals) lines.push(`Goals: ${pc.businessGoals}`);
  if (pc.knownConstraints) lines.push(`Constraints: ${pc.knownConstraints}`);
  if (pc.expectedTimeline) lines.push(`Timeline: ${pc.expectedTimeline}`);
  if (pc.estimatedUsers) lines.push(`Scale: ${pc.estimatedUsers}`);
  if (pc.budgetSensitivity) lines.push(`Budget sensitivity: ${pc.budgetSensitivity}`);
  if (pc.cloudProviders.length) lines.push(`Cloud: ${pc.cloudProviders.join(", ")}`);
  if (pc.platforms.length) lines.push(`Platforms: ${pc.platforms.join(", ")}`);
  if (pc.complianceRequirements.length)
    lines.push(`Compliance: ${pc.complianceRequirements.join(", ")}`);
  lines.push(`Greenfield: ${pc.isGreenfield ? "yes" : "no"}`);
  return lines.join("\n");
}

function buildCatalogBlurb(roles: RoleCatalogEntry[]): string {
  return roles
    .map(
      (r) =>
        `- ${r.name} [${r.seniorityRange.join("/")}] — ${r.description ?? ""}${r.whenNeeded ? ` (${r.whenNeeded})` : ""}`,
    )
    .join("\n");
}

function buildFindingsBlurb(
  rows: Array<{
    domain: string;
    findingType: string;
    severity: string;
    title: string;
  }>,
): string {
  if (rows.length === 0) return "(no findings yet)";
  return rows
    .map(
      (f) =>
        `[${f.domain} ${f.findingType} ${f.severity}] ${truncate(f.title, 180)}`,
    )
    .join("\n");
}

function buildRisksBlurb(
  rows: Array<{
    title: string;
    severity: string;
    impact: string;
    likelihood: string;
  }>,
): string {
  if (rows.length === 0) return "(no risks yet)";
  return rows
    .map(
      (r) =>
        `[${r.severity} impact=${r.impact} ${r.likelihood.toLowerCase()}] ${truncate(r.title, 180)}`,
    )
    .join("\n");
}

function buildScoresBlurb(
  rows: Array<{ domain: string; score: number; maturityLevel: string }>,
): string {
  if (rows.length === 0) return "(no domain scores yet)";
  return rows
    .map((s) => `${s.domain}: ${s.score.toFixed(1)} (${s.maturityLevel})`)
    .join("\n");
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// ─── Enum / numeric coercion ────────────────────────────────────

function clamp01(n: number | undefined): number {
  const v = Number(n);
  if (Number.isNaN(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

function clampInt(
  n: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  const v = Number(n);
  if (Number.isNaN(v)) return fallback;
  return Math.round(Math.max(min, Math.min(max, v)));
}

/**
 * Coerce the AI's seniority string to the Prisma enum. If the value is
 * outside the role's allowed range, pick the closest value that is — keeps
 * the proposal consistent with the role catalog's contract.
 */
function coerceSeniority(
  raw: string | undefined,
  allowed: string[],
): Seniority {
  const k = (raw ?? "").trim().toUpperCase();
  const allowedSet = new Set(allowed.map((s) => s.toUpperCase()));
  if (
    (k === "JUNIOR" || k === "MID" || k === "SENIOR" || k === "LEAD" || k === "PRINCIPAL") &&
    allowedSet.has(k)
  ) {
    return k as Seniority;
  }
  // Not in range — fall back to the middle of the allowed range.
  const order: Seniority[] = ["JUNIOR", "MID", "SENIOR", "LEAD", "PRINCIPAL"];
  const inRange = order.filter((o) => allowedSet.has(o));
  if (inRange.length === 0) return "SENIOR";
  return inRange[Math.floor(inRange.length / 2)];
}
