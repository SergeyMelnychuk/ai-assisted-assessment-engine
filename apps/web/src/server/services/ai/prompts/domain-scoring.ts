export const DOMAIN_SCORING_SYSTEM_PROMPT = `You are an expert assessment scoring analyst for a software consulting company.

CRITICAL OUTPUT RULES — non-negotiable:
- Respond with a SINGLE JSON object and nothing else.
- Do NOT include any prose, headings, or markdown before or after the JSON.
- Do NOT wrap the JSON in a \`\`\`json fence. The response body must start with '{' and end with '}'.
- A truncated or commentary-wrapped response is discarded.

Your task is to score each active assessment domain against a 5-level maturity rubric based on the collected evidence, answered questions, and findings. You must return an AI-suggested score that a human reviewer can then adjust.

Scoring principles:
- Each domain has an explicit 5-level maturity rubric (1 = ad-hoc, 5 = optimized). Match the evidence to the closest level.
- Score is a continuous number 1.0–5.0 (half-levels allowed) that best represents the evidence.
- MaturityLevel is the enum bucket: AD_HOC (≈1), INITIAL (≈2), DEFINED (≈3), MANAGED (≈4), OPTIMIZED (≈5).
- Confidence 0.0–1.0 reflects how well evidence supports the score. Low confidence = thin or conflicting evidence.
- Rationale MUST cite concrete evidence or answered questions — not general industry observations.
- If a domain has zero evidence, return it with score 0, confidence 0, and a rationale explaining the gap.

Output JSON:
{
  "domainScores": [
    {
      "domain": "string (snake_case, from the active domains list)",
      "score": 0.0-5.0,
      "maturityLevel": "AD_HOC | INITIAL | DEFINED | MANAGED | OPTIMIZED",
      "confidence": 0.0-1.0,
      "scoringRationale": "1–3 sentence citation-backed justification"
    }
  ]
}`;

export function buildDomainScoringPrompt(opts: {
  assessmentMode: string;
  activeDomains: string[];
  rubric: string;
  projectContext: string;
  evidences: string;
  answeredQuestions: string;
  findings: string;
}): string {
  return `Score each active domain for a ${opts.assessmentMode} assessment.

Active domains (produce exactly one score for each — skip none):
${opts.activeDomains.join(", ")}

Rubric (by domain):
${opts.rubric}

Project context:
${opts.projectContext}

Collected evidence:
${opts.evidences}

Answered questions:
${opts.answeredQuestions}

Findings so far:
${opts.findings}

Return scores as JSON.`;
}

/**
 * Per-domain scoring user-content builder — Phase 3 Week 2 (ADR-0002).
 * Scopes the call to one domain so output stays within a tight
 * per-call budget; the fan-out loop in `scoring-service.ts` calls this
 * once per active domain and aggregates results.
 */
export function buildPerDomainScoringPrompt(opts: {
  domain: string;
  assessmentMode: string;
  rubric: string;
  projectContext: string;
  evidences: string;
  answeredQuestions: string;
  findings: string;
}): string {
  return `Score a single domain for a ${opts.assessmentMode} assessment.

Domain to score: "${opts.domain}" (your output's "domain" field MUST be exactly this string).

Rubric for ${opts.domain}:
${opts.rubric}

Project context:
${opts.projectContext}

Collected evidence (filtered to ${opts.domain} where available):
${opts.evidences}

Answered questions for ${opts.domain}:
${opts.answeredQuestions}

Findings so far for ${opts.domain}:
${opts.findings}

Return a JSON object of the shape {"domainScores":[{...one entry...}]}.`;
}
