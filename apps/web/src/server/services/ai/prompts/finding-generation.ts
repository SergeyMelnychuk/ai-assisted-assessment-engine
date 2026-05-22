/**
 * Per-call input char budget — used to size evidence/context blurbs so a
 * single Claude call stays well under the input limit. Phase 3 Week 2
 * (ADR-0002) dropped this from an effective ~120k (combined-call) to
 * ~40k (per-domain). The Phase 3 roadmap gap-fill (Week 2 tail) halves
 * it again to 20_000 chars because:
 *   - Per-domain dispatch means each call only reasons over one
 *     domain's evidence slice; RAG top-K (20 chunks × ~800 tokens) fits
 *     comfortably under 20k chars with room left for rubric + project
 *     blurb + KB patterns.
 *   - Smaller per-call inputs improve Anthropic prompt-cache hit-rates
 *     (ADR-0012) — the fixed-ish system+rubric prefix dominates a
 *     larger fraction of the prompt when the variable tail is tighter.
 *   - Cost: at $3 / 1M input tokens, halving per-call input saves
 *     ~$0.01 per domain × 8 domains × 3 runs ≈ $0.24 per engagement —
 *     a round-trip win against negligible precision loss.
 *
 * The constant lives on the prompt module (not claude-client) because
 * each prompt can tune its own budget — scoring doesn't need the same
 * ceiling as finding generation. See ADR-0002.
 */
export const MAX_CLAUDE_INPUT_CHARS = 20_000;

export const FINDING_GENERATION_SYSTEM_PROMPT = `You are an expert assessment analyst generating findings for a software assessment engagement.

CRITICAL OUTPUT RULES — non-negotiable:
- Respond with a SINGLE JSON object and nothing else.
- Do NOT include any prose, headings, or markdown before or after the JSON.
- Do NOT wrap the JSON in a \`\`\`json fence. The response body must start with '{' and end with '}'.
- Do NOT include preamble like "Here is the analysis" or "# Domain Analysis".
- Keep descriptions concise (2–4 sentences each) so the response fits in the output budget — a truncated JSON is discarded.

Your task is to analyze all collected evidence and produce structured findings organized by domain.

For each finding you must:
1. Classify it: strength, weakness, gap, observation, or opportunity
2. Provide a clear title and detailed description
3. Reference which evidence supports it (by evidence ID)
4. Assign a confidence level (0.0-1.0)
5. Assign a severity: critical, high, medium, low, info
6. Distinguish between evidence-backed findings and inferred findings

Principles:
- Be specific, not generic
- Cite evidence
- Don't present assumptions as facts
- Flag low-confidence findings explicitly
- Include both positive findings (strengths) and negative ones (weaknesses, gaps)

Output as JSON:
{
  "findings": [
    {
      "domain": "string",
      "findingType": "strength | weakness | gap | observation | opportunity",
      "title": "string",
      "description": "string",
      "evidenceIds": ["string"],
      "confidence": 0.0-1.0,
      "severity": "critical | high | medium | low | info"
    }
  ],
  "risks": [
    {
      "title": "string",
      "category": "string",
      "description": "string",
      "evidenceIds": ["string"],
      "impact": "critical | high | medium | low",
      "likelihood": "very_likely | likely | possible | unlikely",
      "severity": "critical | high | medium | low",
      "mitigationProposal": "string",
      "ownerSuggestion": "string",
      "confidence": 0.0-1.0
    }
  ],
  "recommendations": [
    {
      "domain": "string",
      "title": "string",
      "description": "string",
      "priority": "critical | high | medium | low",
      "effortIndication": "string",
      "relatedRiskIds": [],
      "confidence": 0.0-1.0
    }
  ],
  "assumptions": [
    {
      "assumptionText": "string",
      "impactIfWrong": "string",
      "source": "ai_inferred | stakeholder_stated | evidence_based",
      "confidence": 0.0-1.0
    }
  ]
}`;

/**
 * Legacy combined-call builder. Kept for any caller that still wants a
 * single all-domains analysis; the Week 2 per-domain fan-out uses
 * {@link buildPerDomainFindingPrompt} instead.
 */
export function buildFindingGenerationPrompt(opts: {
  assessmentMode: string;
  projectContext: string;
  evidences: string;
  domainScores: string;
  knowledgeBaseContext: string;
}): string {
  const body = `Analyze the following evidence from a ${opts.assessmentMode} assessment and generate findings, risks, recommendations, and assumptions.

Project context:
${opts.projectContext}

Collected evidence:
${opts.evidences}

Current domain scores:
${opts.domainScores}

Relevant knowledge base patterns:
${opts.knowledgeBaseContext}

Generate comprehensive, evidence-backed findings. Provide your response as JSON.`;
  return clampToBudget(body);
}

/**
 * Per-domain user-content builder — Phase 3 Week 2. The system prompt is
 * identical across domains (cache-friendly for the Week 8 prompt-caching
 * work) but the user content is scoped to a single domain: its evidence
 * slice, its risk patterns, its scoring rubric.
 *
 * The emitted prompt directs the model to produce findings /
 * recommendations for `opts.domain` only. Risks and assumptions may
 * naturally cross domains, so we allow them but expect most to
 * align with the named domain.
 */
export function buildPerDomainFindingPrompt(opts: {
  domain: string;
  assessmentMode: string;
  projectContext: string;
  evidences: string;
  domainScores: string;
  knowledgeBaseContext: string;
}): string {
  const body = `Analyze the evidence below for a ${opts.assessmentMode} assessment and produce findings, risks, recommendations, and assumptions **scoped to a single domain: "${opts.domain}"**.

Rules:
- Every "domain" field in your output must be exactly "${opts.domain}" — don't invent sibling domains or re-case the name.
- Focus on ${opts.domain}-relevant observations; ignore evidence that isn't about ${opts.domain}.
- Risks can cross-cut but should tie back to ${opts.domain} concerns.
- Return an empty array for any category you genuinely have no evidence for — don't pad.

Project context:
${opts.projectContext}

Evidence (filtered to ${opts.domain} and generic ingest-tagged rows):
${opts.evidences}

Prior domain scores (all domains — context only):
${opts.domainScores}

Knowledge-base risk patterns for ${opts.domain}:
${opts.knowledgeBaseContext}

Provide your response as JSON matching the schema in the system prompt.`;
  return clampToBudget(body);
}

/**
 * Truncate the user-content blob to `MAX_CLAUDE_INPUT_CHARS` so a very
 * large evidence set can't run the prompt past its budget. We slice
 * late rather than early so the domain/rule preamble always survives.
 */
function clampToBudget(s: string): string {
  if (s.length <= MAX_CLAUDE_INPUT_CHARS) return s;
  const marker = "\n\n[... truncated to fit per-call input budget ...]";
  return s.slice(0, MAX_CLAUDE_INPUT_CHARS - marker.length) + marker;
}
