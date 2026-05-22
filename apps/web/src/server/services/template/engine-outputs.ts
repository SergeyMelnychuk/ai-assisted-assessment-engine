import type { PrismaClient } from "@prisma/client";

/**
 * Engine outputs flattened for template filling.
 *
 * Built once per fill and passed through to the filler. Pure data —
 * no methods, no Prisma proxies. We snapshot it onto the
 * `TemplateFill.inputsSnapshot` JSON so an audit-grade replay months
 * later still produces the same output even if the underlying
 * proposals/estimates are later edited.
 */
export interface EngineOutputs {
  roles: ReadonlyArray<{
    roleName: string;
    seniority: string;
    count: number;
    hoursLow: number;
    hoursHigh: number;
    hourlyRate: number;
    costLow: number;
    costHigh: number;
    justification: string;
    responsibilities: string;
    phase: string | null;
  }>;
  totals: {
    effortHoursLow: number;
    effortHoursHigh: number;
    costLow: number;
    costHigh: number;
    scenarioName: string;
    assumptions: string;
    confidence: number;
    currency: string;
  };
  project: {
    name: string;
    industry: string;
    description: string;
    businessGoals: string;
    expectedTimeline: string;
    budgetSensitivity: string;
    complianceRequirements: string[];
  };
  engagement: {
    name: string;
    clientName: string;
  };
  assessment: {
    findingsCount: number;
    risksCount: number;
    recommendationsCount: number;
    activeDomains: string[];
  };
  findings: {
    bulletList: string;
  };
  risks: {
    bulletList: string;
  };
  recommendations: {
    bulletList: string;
  };
  generated: {
    date: string;
    timestamp: string;
  };
}

/**
 * Pull the latest engine outputs for an assessment into the flat
 * shape the filler walks. Called from the runEstimation /
 * generateDeliverable workers right before they hand off to the
 * filler.
 */
export async function loadEngineOutputs(
  db: PrismaClient,
  assessmentId: string,
): Promise<EngineOutputs> {
  const [
    assessment,
    proposals,
    latestEstimate,
    findings,
    risks,
    recommendations,
  ] = await Promise.all([
    db.assessment.findUnique({
      where: { id: assessmentId },
      include: {
        engagement: { select: { name: true, clientName: true } },
        projectContext: true,
      },
    }),
    db.roleProposal.findMany({
      where: { assessmentId },
      orderBy: [{ phase: "asc" }, { roleName: "asc" }],
    }),
    db.estimate.findFirst({
      where: { assessmentId },
      orderBy: { createdAt: "desc" },
      include: {
        rateCard: { select: { currency: true } },
      },
    }),
    db.finding.findMany({
      where: { assessmentId },
      select: {
        title: true,
        description: true,
        severity: true,
        domain: true,
      },
      orderBy: [{ severity: "asc" }, { domain: "asc" }],
    }),
    db.risk.findMany({
      where: { assessmentId },
      select: {
        title: true,
        description: true,
        severity: true,
        category: true,
      },
      orderBy: [{ severity: "asc" }, { category: "asc" }],
    }),
    db.recommendation.findMany({
      where: { assessmentId },
      select: {
        title: true,
        description: true,
        priority: true,
        domain: true,
      },
      orderBy: [{ priority: "asc" }, { domain: "asc" }],
    }),
  ]);
  if (!assessment) {
    throw new Error(`Assessment ${assessmentId} not found`);
  }

  // Per-role hours/cost — the proposal stores effort low/high; cost
  // is hours × rate. If no estimate exists yet, totals collapse to
  // the proposal aggregate with rate=0 (template still fills, just
  // with zeros — better than crashing).
  const currency = latestEstimate?.rateCard?.currency ?? "USD";
  const roles = proposals.map((p) => {
    const rate =
      // Estimate row carries denormalised role hours; we approximate
      // a per-role rate by dividing total cost by total hours where
      // the estimate has it.
      latestEstimate
        ? Number(latestEstimate.totalCostLow) /
          Math.max(1, latestEstimate.totalEffortHoursLow)
        : 0;
    return {
      roleName: p.roleName,
      seniority: p.seniority,
      count: p.count,
      hoursLow: 0, // proposals don't carry per-role hours yet — see TODO below
      hoursHigh: 0,
      hourlyRate: rate,
      costLow: 0,
      costHigh: 0,
      justification: p.justification,
      responsibilities: p.responsibilities,
      phase: p.phase,
    };
  });

  return {
    roles,
    totals: {
      effortHoursLow: latestEstimate?.totalEffortHoursLow ?? 0,
      effortHoursHigh: latestEstimate?.totalEffortHoursHigh ?? 0,
      costLow: Number(latestEstimate?.totalCostLow ?? 0),
      costHigh: Number(latestEstimate?.totalCostHigh ?? 0),
      scenarioName: latestEstimate?.scenarioName ?? "Default scenario",
      assumptions: latestEstimate?.assumptions ?? "",
      confidence: latestEstimate?.confidence ?? 0.5,
      currency,
    },
    project: {
      name: assessment.projectContext?.projectName ?? assessment.engagement.name,
      industry: assessment.projectContext?.industry ?? "",
      description: assessment.projectContext?.description ?? "",
      businessGoals: assessment.projectContext?.businessGoals ?? "",
      expectedTimeline: assessment.projectContext?.expectedTimeline ?? "",
      budgetSensitivity:
        assessment.projectContext?.budgetSensitivity ?? "",
      complianceRequirements:
        assessment.projectContext?.complianceRequirements ?? [],
    },
    engagement: {
      name: assessment.engagement.name,
      clientName: assessment.engagement.clientName,
    },
    assessment: {
      findingsCount: findings.length,
      risksCount: risks.length,
      recommendationsCount: recommendations.length,
      activeDomains: assessment.activeDomains,
    },
    findings: {
      bulletList: findings
        .map((f) => `- [${f.severity}/${f.domain}] ${f.title}`)
        .join("\n"),
    },
    risks: {
      bulletList: risks
        .map((r) => `- [${r.severity}/${r.category}] ${r.title}`)
        .join("\n"),
    },
    recommendations: {
      bulletList: recommendations
        .map((r) => `- [${r.priority}/${r.domain}] ${r.title}`)
        .join("\n"),
    },
    generated: {
      date: new Date().toISOString().slice(0, 10),
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Resolve a binding `field` string against the engine outputs. The
 * field can be a flat path (`totals.scenarioName`) or an array
 * iterator (`roles[*].roleName`). Returns either:
 *   - a single primitive value
 *   - an array of primitives when the field uses `[*]`
 *   - undefined when the path doesn't resolve
 */
export function resolveEngineField(
  outputs: EngineOutputs,
  field: string,
): string | number | string[] | number[] | undefined {
  // Array iterator path — only one level for v1 (roles[*].x).
  const arrayMatch = field.match(/^([\w]+)\[\*\]\.(.+)$/);
  if (arrayMatch) {
    const [, arrName, rest] = arrayMatch;
    const arr = (outputs as unknown as Record<string, unknown>)[arrName];
    if (!Array.isArray(arr)) return undefined;
    return arr.map((row) => {
      const v = (row as Record<string, unknown>)[rest];
      return typeof v === "number" || typeof v === "string" ? v : "";
    }) as string[] | number[];
  }
  // Flat path: dot-walk the object.
  const parts = field.split(".");
  let cur: unknown = outputs;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as object)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  if (typeof cur === "string" || typeof cur === "number") return cur;
  if (Array.isArray(cur)) {
    // String-only or number-only arrays (the binding spec doesn't
    // mix them in one path). Mixed arrays coerce to strings.
    const allStrings = cur.every((x) => typeof x === "string");
    if (allStrings) return cur as string[];
    const allNumbers = cur.every((x) => typeof x === "number");
    if (allNumbers) return cur as number[];
    return cur.map((x) => String(x));
  }
  return undefined;
}
