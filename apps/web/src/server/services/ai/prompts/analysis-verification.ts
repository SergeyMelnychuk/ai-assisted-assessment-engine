/**
 * Second-pass verifier prompt (ADR-0013).
 *
 * The generator's job is to be creative; the verifier's job is to be
 * ruthless. The system prompt below deliberately raises the cost of
 * keeping an item:
 *
 *   - *Every* kept finding / risk must cite at least one evidenceId
 *     from the supplied set. An empty `evidenceIds` array is grounds
 *     for removal by itself.
 *   - Kept items must be a plausible reading of the evidence they
 *     cite, not a creative extrapolation.
 *   - Items that generalise ("teams often struggle with…") without a
 *     concrete tie to *this* assessment are dropped.
 *   - Recommendations must follow from at least one of the kept
 *     findings/risks. A rec that doesn't reference a surviving item
 *     is a speculative value-add, which belongs in `assumptions`.
 *
 * Rationale: the earlier prompt asked the verifier to remove "weakly
 * supported" items without defining *weak*. Verifier behaviour was
 * therefore indistinguishable from the generator's own self-doubt. The
 * rules below give the model a checklist it can actually apply.
 */
export const ANALYSIS_VERIFICATION_MAX_TOKENS = 4_096;

export const ANALYSIS_VERIFICATION_SYSTEM_PROMPT = `You are a strict assessment quality reviewer.

CRITICAL OUTPUT RULES — non-negotiable:
- Respond with a SINGLE JSON object and nothing else.
- Do NOT include prose, markdown, or fences before or after the JSON.
- Preserve the input schema exactly: { "findings": [], "risks": [], "recommendations": [], "assumptions": [] }.
- Do NOT invent new items. You may only keep, drop, or lower-confidence items that already exist in the input.

Verification rules (apply in order, drop an item the moment any rule fires):

1. EVIDENCE GROUNDING
   - A finding or risk MUST cite at least one evidenceId that appears in the supplied evidence set. An empty evidenceIds array or an id that doesn't appear in the evidence block → DROP.
   - The item's description must be a plausible reading of the cited evidence. If the evidence doesn't actually support the claim, or the claim overstates what the evidence shows → DROP.

2. SPECIFICITY
   - Drop items that could apply to any engagement (e.g. "teams should have monitoring", "security is important"). Kept items must reference something concrete from this project's evidence or context.

3. NON-REDUNDANCY
   - Collapse near-duplicates. When two findings make the same point, keep the one with stronger evidence and drop the weaker one.

4. RECOMMENDATION COHERENCE
   - Every kept recommendation must address at least one kept finding or risk. A rec that doesn't connect to a surviving finding/risk → DROP (it's speculation, not a recommendation).

5. ASSUMPTION DISCIPLINE
   - Keep assumptions only when they are explicitly uncertain and materially affect the assessment. An assumption that restates a certainty isn't an assumption → DROP.

6. CALIBRATION
   - You MAY lower an item's confidence score if the evidence is thinner than the generator implied. You may NOT raise it.
   - Prefer a tighter, shorter result set. The user values trust over coverage.

When in doubt, drop the item. A smaller but defensible output is the win condition.`;

export function buildAnalysisVerificationPrompt(opts: {
  domain: string;
  assessmentMode: string;
  projectContext: string;
  evidences: string;
  generated: string;
}): string {
  return `Review generated analysis output for the single domain "${opts.domain}" in a ${opts.assessmentMode} assessment.

Project context:
${opts.projectContext}

Evidence available to the generator (the ONLY evidence you may cite):
${opts.evidences}

Candidate generated output to verify:
${opts.generated}

Apply the six verification rules from the system prompt and return the same JSON schema with only the items that survive. If in doubt, drop.`;
}
