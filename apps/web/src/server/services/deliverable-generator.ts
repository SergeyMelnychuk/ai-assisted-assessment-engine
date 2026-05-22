import fs from "node:fs";
import path from "node:path";
import type {
  DeliverableType,
  Prisma,
  PrismaClient,
  DiagramContentType,
  DiagramFormat,
} from "@prisma/client";
import {
  callClaude,
  parseJsonResponse,
} from "./ai/router";
import {
  DELIVERABLE_SINGLE_SECTION_SYSTEM_PROMPT,
  buildDeliverableSingleSectionPrompt,
} from "./ai/prompts/deliverable-sections";
import { generateDiagram } from "./diagram-generator";
import { retrieve } from "./rag-retriever";
import { maybeAdvanceAssessmentStage } from "./assessment-stage";

/**
 * Deliverable generator — orchestrates the full deliverable production:
 *
 *   1. Plan diagrams (from the template + what data is available)
 *   2. Generate each diagram's source (Claude, one call per diagram)
 *   3. Generate all sections in a SINGLE Claude call (batched)
 *   4. Persist Deliverable + Diagram rows + DeliverableSection rows
 *      atomically
 *
 * The diagram image-rendering step (mmdc) is intentionally not invoked
 * here: it requires Chromium-in-puppeteer which isn't installed in the
 * dev container. We store `sourceCode` on the Diagram rows so the UI
 * can render client-side (or users can copy into mermaid.live).
 */

// ─── Template loading ────────────────────────────────────────────

interface SectionSpec {
  key: string;
  title: string;
  purpose: string;
  targetLength: "short" | "medium" | "long";
  audience?: string;
  includesDiagrams?: string[];
}
interface TemplateDiagramSpec {
  key: string;
  title: string;
  diagramType: DiagramContentType;
  outputFormat: DiagramFormat;
  description: string;
  applicableModes?: string[];
}
interface DeliverableTemplate {
  key: string;
  name: string;
  description?: string;
  deliverableType: DeliverableType;
  applicableModes?: string[];
  sections: SectionSpec[];
  diagrams: TemplateDiagramSpec[];
}

// Resolved at module load — small enough (~50 lines) to keep in memory.
// If the seed folder moves, re-derive via the same relative walk we use
// in prisma/seed.ts. Kept as a local copy here so the web server doesn't
// need to round-trip through the @copilot/knowledge-seed package import.
const TEMPLATES_DIR = path.resolve(
  process.cwd(),
  "../../packages/knowledge-seed/deliverable-templates",
);

let templatesCache: DeliverableTemplate[] | null = null;

function loadTemplates(): DeliverableTemplate[] {
  if (templatesCache) return templatesCache;
  if (!fs.existsSync(TEMPLATES_DIR)) {
    templatesCache = [];
    return templatesCache;
  }
  const files = fs
    .readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  templatesCache = files.map(
    (f) =>
      JSON.parse(
        fs.readFileSync(path.join(TEMPLATES_DIR, f), "utf8"),
      ) as DeliverableTemplate,
  );
  return templatesCache;
}

/**
 * Given an assessment mode + deliverable type, return the matching template.
 * Falls back to the first template that claims to cover this mode, or the
 * first template overall if no mode metadata lines up.
 *
 * If no JSON spec exists for the deliverable type at all, **synthesise a
 * minimal generic spec** rather than throwing. This unlocks all 10
 * deliverable types end-to-end now that customers can upload their own
 * shells per type — the JSON spec is only needed to drive AI content
 * writing, and a single-section "narrative" spec is good enough for
 * types we haven't authored a hand-tuned spec for yet. The customer-
 * uploaded template (xlsx/docx/pptx) is filled separately via
 * `fillAndStoreForAssessment` after this generator finishes.
 */
function pickTemplate(
  deliverableType: DeliverableType,
  mode: string,
): DeliverableTemplate {
  const all = loadTemplates();
  const byType = all.filter((t) => t.deliverableType === deliverableType);
  if (byType.length > 0) {
    const exact = byType.find((t) => t.applicableModes?.includes(mode));
    return exact ?? byType[0]!;
  }
  return synthesiseGenericTemplate(deliverableType);
}

/**
 * Build a minimal one-section spec for a deliverable type that has no
 * hand-authored JSON file. The AI writes a single narrative section
 * keyed off the deliverable type's name; the customer's uploaded
 * template carries the actual structure (slides, sections, cells).
 */
function synthesiseGenericTemplate(
  deliverableType: DeliverableType,
): DeliverableTemplate {
  const humanLabel = deliverableType
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    key: `${deliverableType.toLowerCase()}_generic`,
    name: humanLabel,
    description: `Generic spec auto-synthesised for ${humanLabel}. Sections come from the uploaded template's binding.`,
    deliverableType,
    applicableModes: [
      "EXISTING_SYSTEM",
      "MODERNIZATION",
      "AUDIT",
      "PRE_IMPLEMENTATION",
      "GREENFIELD",
    ],
    sections: [
      {
        key: "narrative",
        title: humanLabel,
        purpose: `Synthesise the ${humanLabel} content based on the assessment's findings, risks, recommendations, and project context. The customer-uploaded template (if any) controls the final layout; this section provides the prose the filler stamps into placeholders.`,
        targetLength: "medium",
        audience: "Engagement sponsor + engineering leadership",
      },
    ],
    diagrams: [],
  };
}

// ─── Main entry point ───────────────────────────────────────────

export interface DeliverableRunResult {
  deliverableId: string;
  diagramsGenerated: number;
  sectionsGenerated: number;
  tokensUsed: { input: number; output: number };
}

export async function runDeliverableGeneration(
  db: PrismaClient,
  assessmentId: string,
  deliverableType: DeliverableType = "ASSESSMENT_REPORT",
): Promise<DeliverableRunResult> {
  const assessment = await db.assessment.findUnique({
    where: { id: assessmentId },
    include: {
      projectContext: true,
      assessmentType: true,
    },
  });
  if (!assessment) throw new Error(`Assessment ${assessmentId} not found`);

  // `pickTemplate` always returns a spec — either a hand-authored JSON
  // from `packages/knowledge-seed/deliverable-templates/` or a
  // synthesised generic one (see `synthesiseGenericTemplate`). The
  // populated file's structure comes from the customer-uploaded
  // template via `fillAndStoreForAssessment` downstream.
  const template = pickTemplate(deliverableType, assessment.mode);

  // Pull all the analysis outputs this deliverable will stitch together.
  // Caps are generous but bounded so the prompt doesn't balloon past 60k
  // tokens on an unusually large assessment.
  const [findings, risks, recommendations, domainScores, assumptions, teamProposals, latestEstimate] =
    await Promise.all([
      db.finding.findMany({
        where: { assessmentId },
        orderBy: [{ severity: "asc" }, { domain: "asc" }],
        take: 40,
      }),
      db.risk.findMany({
        where: { assessmentId },
        orderBy: { severity: "asc" },
        take: 40,
      }),
      db.recommendation.findMany({
        where: { assessmentId },
        orderBy: { priority: "asc" },
        take: 40,
      }),
      db.domainScore.findMany({ where: { assessmentId } }),
      db.assumption.findMany({
        where: { assessmentId },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      db.roleProposal.findMany({ where: { assessmentId } }),
      db.estimate.findFirst({
        where: { assessmentId },
        orderBy: { createdAt: "desc" },
      }),
    ]);

  const projectBlurb = buildProjectBlurb(assessment.projectContext);

  // ── Diagram generation pass ──
  // Filter down to diagrams that apply to the current mode, then call
  // Claude once per diagram. One call per diagram is deliberate — each
  // produces a different format and keeps the output small enough to
  // parse cleanly.
  const applicableDiagrams = template.diagrams.filter(
    (d) => !d.applicableModes || d.applicableModes.includes(assessment.mode),
  );
  const diagramResults: Array<{
    spec: TemplateDiagramSpec;
    sourceCode: string;
  }> = [];
  let tokensInput = 0;
  let tokensOutput = 0;

  for (const spec of applicableDiagrams) {
    try {
      const res = await generateDiagram({
        diagramType: spec.diagramType,
        outputFormat: spec.outputFormat,
        description: spec.description,
        title: spec.title,
        assessmentContext: buildDiagramContextBlurb({
          assessment,
          findings,
          risks,
          recommendations,
          domainScores,
        }),
      });
      diagramResults.push({ spec, sourceCode: res.sourceCode });
    } catch (err) {
      // A single failed diagram shouldn't take down the whole deliverable.
      // Log and continue; the deliverable will note the gap.
      console.error(
        `[deliverable-gen] diagram '${spec.key}' failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ── Section generation pass (one batched Claude call) ──
  const diagramReferences = diagramResults
    .map((d) => `- ${d.spec.title} (${d.spec.key}, ${d.spec.diagramType})`)
    .join("\n") || "(no diagrams generated this run)";

  // Per-section retrieval (Phase 3 Week 4, ADR-0007). Each section's
  // `purpose` is the embedding query; the top chunks are inlined into
  // the prompt. One retrieval per section is deliberate — different
  // sections need different chunks, and the batched Claude call here
  // is the single output channel.
  const sectionChunks = await Promise.all(
    template.sections.map((spec) =>
      retrieve(db, {
        assessmentId,
        query: spec.purpose || spec.title,
        topK: 8,
      }),
    ),
  );
  // Per-section fan-out. Previously this was a single batched Claude
  // call producing ~9 section bodies; on dense assessments that
  // exceeded both the per-call timeout (240 s) and the maxTokens
  // budget, and the entire deliverable failed when any one section
  // ran long. Splitting per section means:
  //   - each call has its own ~3 k token output ceiling, well under
  //     the per-call timeout;
  //   - a single section's failure produces a placeholder, not a
  //     run-wide failure;
  //   - sections run in parallel with a small concurrency cap so we
  //     don't burst Anthropic with 9 simultaneous calls.
  const SECTION_CONCURRENCY = 3;

  // Map each section to its retrieved-evidence blurb (built earlier
  // in `sectionChunks`), so per-section prompts stay self-contained.
  const evidenceByKey = new Map<string, string>();
  template.sections.forEach((spec, i) => {
    const chunks = sectionChunks[i] ?? [];
    if (chunks.length === 0) return;
    evidenceByKey.set(
      spec.key,
      chunks
        .slice(0, 8)
        .map((c, idx) => `[${idx + 1}] ${truncate(c.content, 240)}`)
        .join("\n"),
    );
  });
  const contentByKey = new Map<string, string>();
  const sectionFailures: Array<{ key: string; message: string }> = [];

  // Simple rolling-window concurrency. Promise.all on the whole batch
  // would max-burst Anthropic; sequential is too slow with 9 sections.
  const queue = [...template.sections];
  await Promise.all(
    Array.from({ length: SECTION_CONCURRENCY }, async () => {
      while (queue.length > 0) {
        const spec = queue.shift();
        if (!spec) break;
        try {
          const ai = await callClaude({
            system: DELIVERABLE_SINGLE_SECTION_SYSTEM_PROMPT,
            userContent: buildDeliverableSingleSectionPrompt({
              assessmentMode: assessment.mode,
              activeDomains: assessment.activeDomains,
              projectContext: projectBlurb,
              findings: buildFindingsBlurb(findings),
              risks: buildRisksBlurb(risks),
              recommendations: buildRecsBlurb(recommendations),
              domainScores: buildScoresBlurb(domainScores),
              assumptions: buildAssumptionsBlurb(assumptions),
              teamProposal: buildTeamBlurb(teamProposals),
              estimate: buildEstimateBlurb(latestEstimate),
              diagrams: diagramReferences,
              section: {
                key: spec.key,
                title: spec.title,
                purpose: spec.purpose,
                audience: spec.audience ?? "stakeholders",
                targetLength: spec.targetLength,
                includesDiagrams:
                  (spec.includesDiagrams?.length ?? 0) > 0,
              },
              sectionEvidence: evidenceByKey.get(spec.key),
            }),
            parseResult: (raw) =>
              parseJsonResponse<{ content?: string }>(raw),
            // ~3 k tokens per section comfortably covers a "long"
            // section (8 paragraphs or a structured table).
            maxTokens: 3_500,
            audit: {
              callType: "deliverable",
              entityId: assessmentId,
              entityType: "Assessment",
            },
          });
          tokensInput += ai.tokensUsed.input;
          tokensOutput += ai.tokensUsed.output;
          if (typeof ai.result.content === "string") {
            contentByKey.set(spec.key, ai.result.content.trim());
          } else {
            sectionFailures.push({
              key: spec.key,
              message: "model returned no `content` field",
            });
          }
        } catch (err) {
          // One section's failure shouldn't kill the whole run. Log
          // it and continue; the placeholder gets persisted below.
          sectionFailures.push({
            key: spec.key,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }),
  );

  if (sectionFailures.length === template.sections.length) {
    // Every section failed — surface the first error so the run
    // fails clearly instead of producing an empty placeholder
    // deliverable.
    throw new Error(
      `All ${sectionFailures.length} deliverable sections failed. First error: ${sectionFailures[0]?.message}`,
    );
  }
  if (sectionFailures.length > 0) {
    console.warn(
      `[deliverable-generator] ${sectionFailures.length}/${template.sections.length} sections failed:`,
      sectionFailures
        .map((f) => `${f.key}: ${f.message}`)
        .join(" | "),
    );
  }

  // Build final section inserts in template order. If the AI skipped a
  // section (rare), we still create the row so the UI's section list
  // stays stable — with a placeholder the reviewer can fill in.
  const sectionInserts = template.sections.map((spec, idx) => ({
    sectionKey: spec.key,
    title: spec.title,
    orderIndex: idx,
    contentDraft:
      contentByKey.get(spec.key) ??
      `_(section not drafted by the AI — add content manually)_`,
    evidenceIds: [] as string[],
  }));

  // ── Atomic persistence ──
  // Replace any prior Deliverable of the same type in DRAFT state + its
  // children (cascades), keeping reviewed deliverables untouched.
  const result = await db.$transaction(async (tx) => {
    await tx.deliverable.deleteMany({
      where: {
        assessmentId,
        deliverableType,
        status: { in: ["GENERATING", "DRAFT"] },
      },
    });
    await tx.diagram.deleteMany({
      where: {
        assessmentId,
        direction: "GENERATED",
        // Drop previous GENERATED diagrams so we don't accumulate stale ones.
      },
    });

    const deliverable = await tx.deliverable.create({
      data: {
        assessmentId,
        deliverableType,
        templateId: template.key,
        status: "DRAFT",
        sections: {
          create: sectionInserts,
        },
      },
    });

    for (const d of diagramResults) {
      await tx.diagram.create({
        data: {
          assessmentId,
          deliverableId: deliverable.id,
          direction: "GENERATED",
          diagramFormat: d.spec.outputFormat,
          title: d.spec.title,
          description: d.spec.description,
          sourceCode: d.sourceCode,
          diagramType: d.spec.diagramType,
          processingStatus: "PROCESSED",
        },
      });
    }

    await tx.auditLog.create({
      data: {
        action: "GENERATE_DELIVERABLE",
        entityType: "Deliverable",
        entityId: deliverable.id,
        details: {
          assessmentId,
          templateId: template.key,
          deliverableType,
          sections: sectionInserts.length,
          diagrams: diagramResults.length,
          tokens: { input: tokensInput, output: tokensOutput },
        } as Prisma.JsonObject,
      },
    });

    return {
      deliverableId: deliverable.id,
      diagramsGenerated: diagramResults.length,
      sectionsGenerated: sectionInserts.length,
    };
  });

  // A draft deliverable has landed → nudge stage to REVIEW so the
  // dashboard reflects "ready to look at" instead of leaving it stuck
  // at DRAFTING after the analysis job's earlier bump. Outside the
  // transaction so an audit-row failure can't unwind the deliverable.
  await maybeAdvanceAssessmentStage(db, assessmentId, "REVIEW", {
    trigger: "deliverable.generated",
    extra: {
      deliverableId: result.deliverableId,
      deliverableType,
    },
  });

  return {
    ...result,
    tokensUsed: { input: tokensInput, output: tokensOutput },
  };
}

// ─── Blurb helpers (prompt construction) ─────────────────────────

function buildProjectBlurb(
  pc: {
    projectName: string | null;
    description: string | null;
    industry: string | null;
    businessGoals: string | null;
    knownConstraints: string | null;
    expectedTimeline: string | null;
    estimatedUsers: string | null;
    complianceRequirements: string[];
    cloudProviders: string[];
    platforms: string[];
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
  if (pc.complianceRequirements.length)
    lines.push(`Compliance: ${pc.complianceRequirements.join(", ")}`);
  if (pc.cloudProviders.length)
    lines.push(`Cloud: ${pc.cloudProviders.join(", ")}`);
  if (pc.platforms.length)
    lines.push(`Platforms: ${pc.platforms.join(", ")}`);
  lines.push(`Greenfield: ${pc.isGreenfield ? "yes" : "no"}`);
  return lines.join("\n");
}

function buildFindingsBlurb(
  rows: Array<{
    id: string;
    domain: string;
    findingType: string;
    severity: string;
    title: string;
    description: string;
    confidence: number;
  }>,
): string {
  if (rows.length === 0) return "(no findings)";
  return rows
    .map(
      (f) =>
        `[${f.domain} ${f.findingType} ${f.severity} conf=${f.confidence.toFixed(2)}] ${f.title}: ${truncate(f.description, 220)}`,
    )
    .join("\n");
}

function buildRisksBlurb(
  rows: Array<{
    title: string;
    category: string;
    description: string;
    severity: string;
    impact: string;
    likelihood: string;
    mitigationProposal: string | null;
  }>,
): string {
  if (rows.length === 0) return "(no risks)";
  return rows
    .map(
      (r) =>
        `[${r.severity} impact=${r.impact} like=${r.likelihood}] ${r.title} (${r.category}): ${truncate(r.description, 220)}${r.mitigationProposal ? ` // mitigation: ${truncate(r.mitigationProposal, 200)}` : ""}`,
    )
    .join("\n");
}

function buildRecsBlurb(
  rows: Array<{
    domain: string;
    title: string;
    description: string;
    priority: string;
    effortIndication: string | null;
  }>,
): string {
  if (rows.length === 0) return "(no recommendations)";
  return rows
    .map(
      (r) =>
        `[${r.priority} ${r.domain}${r.effortIndication ? ` effort=${r.effortIndication}` : ""}] ${r.title}: ${truncate(r.description, 220)}`,
    )
    .join("\n");
}

function buildScoresBlurb(
  rows: Array<{
    domain: string;
    score: number;
    maturityLevel: string;
    scoringRationale: string | null;
  }>,
): string {
  if (rows.length === 0) return "(no domain scores)";
  return rows
    .map(
      (s) =>
        `${s.domain}: ${s.score.toFixed(1)} (${s.maturityLevel})${s.scoringRationale ? ` — ${truncate(s.scoringRationale, 200)}` : ""}`,
    )
    .join("\n");
}

function buildAssumptionsBlurb(
  rows: Array<{
    assumptionText: string;
    impactIfWrong: string | null;
    source: string;
    confidence: number;
  }>,
): string {
  if (rows.length === 0) return "(no assumptions captured)";
  return rows
    .map(
      (a) =>
        `[${a.source} conf=${a.confidence.toFixed(2)}] ${truncate(a.assumptionText, 220)}${a.impactIfWrong ? ` // impact: ${truncate(a.impactIfWrong, 200)}` : ""}`,
    )
    .join("\n");
}

function buildTeamBlurb(
  rows: Array<{
    roleName: string;
    seniority: string;
    count: number;
    justification: string;
    phase: string | null;
  }>,
): string {
  if (rows.length === 0) return "(no team proposal yet)";
  return rows
    .map(
      (r) =>
        `${r.count}× ${r.roleName} (${r.seniority.toLowerCase()})${r.phase ? ` [${r.phase}]` : ""}: ${truncate(r.justification, 200)}`,
    )
    .join("\n");
}

function buildEstimateBlurb(
  e: {
    scenarioName: string;
    totalEffortHoursLow: number;
    totalEffortHoursHigh: number;
    totalCostLow: unknown;
    totalCostHigh: unknown;
    assumptions: string | null;
    confidence: number;
  } | null,
): string {
  if (!e) return "(no estimate generated yet)";
  const cLow = Number(String(e.totalCostLow));
  const cHigh = Number(String(e.totalCostHigh));
  return [
    `Scenario: ${e.scenarioName}`,
    `Effort range: ${e.totalEffortHoursLow}h – ${e.totalEffortHoursHigh}h`,
    `Cost range: ${Math.round(cLow).toLocaleString()} – ${Math.round(cHigh).toLocaleString()}`,
    `Confidence: ${e.confidence.toFixed(2)}`,
    e.assumptions ? `Assumptions: ${e.assumptions}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// Removed: `buildSectionManifest` and `buildSectionEvidenceBlurb`.
// Both were inputs to the prior batched-sections prompt; the per-
// section fan-out builds its own slim per-section evidence blurb
// inline (only the chunks for that one section land in each call).

function buildDiagramContextBlurb(opts: {
  assessment: {
    mode: string;
    activeDomains: string[];
    projectContext: {
      projectName: string | null;
      description: string | null;
    } | null;
  };
  findings: Array<{ domain: string; title: string }>;
  risks: Array<{ title: string; severity: string }>;
  recommendations: Array<{ domain: string; title: string; priority: string }>;
  domainScores: Array<{ domain: string; score: number }>;
}): string {
  const parts: string[] = [];
  parts.push(`Mode: ${opts.assessment.mode}`);
  parts.push(`Active domains: ${opts.assessment.activeDomains.join(", ")}`);
  if (opts.assessment.projectContext?.projectName) {
    parts.push(`Project: ${opts.assessment.projectContext.projectName}`);
  }
  if (opts.assessment.projectContext?.description) {
    parts.push(
      `Description: ${truncate(opts.assessment.projectContext.description, 400)}`,
    );
  }
  if (opts.findings.length) {
    parts.push(
      `Key findings:\n${opts.findings
        .slice(0, 10)
        .map((f) => `- [${f.domain}] ${f.title}`)
        .join("\n")}`,
    );
  }
  if (opts.risks.length) {
    parts.push(
      `Top risks:\n${opts.risks
        .slice(0, 10)
        .map((r) => `- [${r.severity}] ${r.title}`)
        .join("\n")}`,
    );
  }
  if (opts.recommendations.length) {
    parts.push(
      `Recommendations:\n${opts.recommendations
        .slice(0, 10)
        .map((r) => `- [${r.priority} ${r.domain}] ${r.title}`)
        .join("\n")}`,
    );
  }
  if (opts.domainScores.length) {
    parts.push(
      `Domain scores:\n${opts.domainScores
        .map((s) => `${s.domain}: ${s.score.toFixed(1)}/5`)
        .join(", ")}`,
    );
  }
  return parts.join("\n\n");
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// ─── Diagram regeneration ────────────────────────────────────────

/**
 * Regenerate a single diagram, optionally with reviewer feedback
 * ("make it more detailed", "add the Redis cache"). The feedback is
 * appended to the prompt description so Claude can respond to it.
 */
export async function regenerateDiagram(
  db: PrismaClient,
  diagramId: string,
  feedback?: string,
): Promise<{ diagramId: string; sourceCode: string }> {
  const diagram = await db.diagram.findUnique({
    where: { id: diagramId },
    include: {
      assessment: {
        include: {
          projectContext: true,
        },
      },
    },
  });
  if (!diagram) throw new Error(`Diagram ${diagramId} not found`);
  if (diagram.direction !== "GENERATED") {
    throw new Error("Only generated diagrams can be regenerated");
  }

  const [findings, risks, recs, scores] = await Promise.all([
    db.finding.findMany({
      where: { assessmentId: diagram.assessmentId },
      orderBy: { severity: "asc" },
      take: 40,
    }),
    db.risk.findMany({
      where: { assessmentId: diagram.assessmentId },
      orderBy: { severity: "asc" },
      take: 40,
    }),
    db.recommendation.findMany({
      where: { assessmentId: diagram.assessmentId },
      orderBy: { priority: "asc" },
      take: 40,
    }),
    db.domainScore.findMany({ where: { assessmentId: diagram.assessmentId } }),
  ]);

  const baseDescription = diagram.description ?? diagram.title;
  const description = feedback?.trim()
    ? `${baseDescription}\n\nReviewer feedback — incorporate this in the regenerated diagram:\n${feedback.trim()}`
    : baseDescription;

  const res = await generateDiagram({
    diagramType: diagram.diagramType ?? "OTHER",
    outputFormat: diagram.diagramFormat,
    description,
    title: diagram.title,
    assessmentContext: buildDiagramContextBlurb({
      assessment: diagram.assessment,
      findings,
      risks,
      recommendations: recs,
      domainScores: scores,
    }),
  });

  await db.diagram.update({
    where: { id: diagramId },
    data: {
      sourceCode: res.sourceCode,
      processingStatus: "PROCESSED",
    },
  });

  return { diagramId, sourceCode: res.sourceCode };
}
