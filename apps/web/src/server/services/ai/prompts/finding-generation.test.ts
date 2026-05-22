import { describe, expect, it } from "vitest";
import {
  MAX_CLAUDE_INPUT_CHARS,
  buildPerDomainFindingPrompt,
} from "./finding-generation";

// Unit tests for the scoped prompt builder introduced in Phase 3 Week 2
// (ADR-0002). Two things matter at this layer:
//   - the prompt scopes to one domain (text + rules),
//   - the assembled string stays inside the per-call input budget.

describe("buildPerDomainFindingPrompt", () => {
  it("scopes the user content to a single domain by name", () => {
    const prompt = buildPerDomainFindingPrompt({
      domain: "security",
      assessmentMode: "architecture",
      projectContext: "Project: Acme",
      evidences: "[id=ev1 domain=security] example chunk",
      domainScores: "(no prior)",
      knowledgeBaseContext: "[security] SQLi — classic one",
    });

    // The domain is named multiple times and the rule about "domain
    // field must be exactly" appears — those are the cues the model
    // latches onto. If we ever paraphrase them, the tests here remind
    // us to update the analysis-engine's `res.domain` pin too.
    expect(prompt).toContain('scoped to a single domain: "security"');
    expect(prompt).toContain('"security"');
    expect(prompt.toLowerCase()).toContain("security");
    // Make sure we didn't accidentally include a sibling domain anywhere.
    expect(prompt.toLowerCase()).not.toContain("performance");
  });

  it("only includes evidence the caller scoped to this domain", () => {
    // The builder doesn't itself filter — the engine does — but we
    // assert the shape so callers don't accidentally pass the full
    // evidence blob. The domain-named header plus the evidence string
    // together form the scope; the builder inserts both verbatim.
    const prompt = buildPerDomainFindingPrompt({
      domain: "performance",
      assessmentMode: "architecture",
      projectContext: "",
      evidences: "EVIDENCE-FOR-PERFORMANCE-ONLY",
      domainScores: "",
      knowledgeBaseContext: "",
    });
    expect(prompt).toContain("EVIDENCE-FOR-PERFORMANCE-ONLY");
    // And the domain-name is woven into the evidence header too.
    expect(prompt).toContain("Evidence (filtered to performance");
  });

  it("stays inside the per-call input budget even with huge evidence", () => {
    const hugeEvidence = "x".repeat(MAX_CLAUDE_INPUT_CHARS * 3);
    const prompt = buildPerDomainFindingPrompt({
      domain: "security",
      assessmentMode: "architecture",
      projectContext: "",
      evidences: hugeEvidence,
      domainScores: "",
      knowledgeBaseContext: "",
    });
    expect(prompt.length).toBeLessThanOrEqual(MAX_CLAUDE_INPUT_CHARS);
    // Truncation marker is present so reviewers know the prompt was clamped.
    expect(prompt).toContain("truncated to fit per-call input budget");
  });

  it("keeps small prompts untouched", () => {
    const prompt = buildPerDomainFindingPrompt({
      domain: "security",
      assessmentMode: "architecture",
      projectContext: "small",
      evidences: "ev",
      domainScores: "",
      knowledgeBaseContext: "",
    });
    expect(prompt).not.toContain("truncated to fit per-call input budget");
  });
});

describe("MAX_CLAUDE_INPUT_CHARS", () => {
  it("is the Week 2 gap-fill (ADR-0002) target of ~20k chars", () => {
    // Guardrail: per-domain dispatch lets us halve the budget from the
    // initial 40k to 20k chars. If this constant drifts the ADR and
    // the consequences section need to move with it.
    expect(MAX_CLAUDE_INPUT_CHARS).toBe(20_000);
  });
});
