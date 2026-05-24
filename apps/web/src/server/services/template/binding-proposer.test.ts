import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// Mock the AI router so we never hit the network (or the resolver
// chain). The proposer only uses `callAi` + `parseJsonResponse`.
vi.mock("@/server/services/ai/router", () => ({
  callAi: vi.fn(),
  parseJsonResponse: vi.fn(),
}));

// Mock structure-extract so we don't pull in `exceljs` as a
// transitive import in this unit test. We pass a non-xlsx mime in
// every test below, so this stub never runs anyway.
vi.mock("./structure-extract", () => ({
  extractXlsxStructure: vi.fn().mockResolvedValue({
    definedNames: [],
    sheets: [],
  }),
}));

import { callAi, parseJsonResponse } from "@/server/services/ai/router";
import { proposeTemplateBinding } from "./binding-proposer";
import { ENGINE_OUTPUT_FIELDS } from "./binding";

// Use a non-xlsx mime so the proposer skips `extractXlsxStructure`
// and just runs its `{{token}}`-scraping path on the buffer text.
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const docxBuffer = Buffer.from("hello {{project_name}} world", "utf8");

beforeEach(() => {
  (callAi as unknown as Mock).mockReset();
  (parseJsonResponse as unknown as Mock).mockReset();
});

describe("proposeTemplateBinding", () => {
  it("returns the binding unchanged when the AI output is valid", async () => {
    const validBinding = {
      version: 1 as const,
      templateKind: "DELIVERABLE_REPORT" as const,
      entries: [
        {
          field: "project.name",
          target: { kind: "docx.placeholder", token: "{{project_name}}" },
        },
        {
          field: "totals.scenarioName",
          target: { kind: "docx.placeholder", token: "{{scenario}}" },
        },
      ],
      notes: "happy path",
    };
    (callAi as unknown as Mock).mockResolvedValue({
      result: validBinding,
      tokensUsed: { input: 123, output: 45 },
    });

    const res = await proposeTemplateBinding({
      templateKind: "DELIVERABLE_REPORT",
      templateMimeType: DOCX_MIME,
      templateBuffer: docxBuffer,
    });

    expect(res.binding).toEqual(validBinding);
    expect(res.warnings).toEqual([]);
    expect(res.tokens).toEqual({ input: 123, output: 45 });
    expect(callAi).toHaveBeenCalledTimes(1);
  });

  it("filters out entries whose field is not in the engine catalog", async () => {
    // Use one valid + one bogus entry. Sanity-check the bogus is not
    // accidentally part of the catalog.
    const bogusField = "totally.made.up.field";
    expect(ENGINE_OUTPUT_FIELDS).not.toContain(bogusField);

    const aiBinding = {
      version: 1 as const,
      templateKind: "ESTIMATION" as const,
      entries: [
        {
          field: "totals.scenarioName",
          target: { kind: "docx.placeholder", token: "{{scn}}" },
        },
        {
          field: bogusField,
          target: { kind: "docx.placeholder", token: "{{huh}}" },
        },
      ],
    };
    (callAi as unknown as Mock).mockResolvedValue({
      result: aiBinding,
      tokensUsed: { input: 10, output: 20 },
    });

    const res = await proposeTemplateBinding({
      templateKind: "ESTIMATION",
      templateMimeType: DOCX_MIME,
      templateBuffer: docxBuffer,
    });

    expect(res.binding.entries).toHaveLength(1);
    expect(res.binding.entries[0]?.field).toBe("totals.scenarioName");
    expect(res.binding.templateKind).toBe("ESTIMATION");
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(res.warnings.some((w) => /Dropped 1/.test(w))).toBe(true);
    expect(res.tokens).toEqual({ input: 10, output: 20 });
  });

  it("returns the empty-binding fallback when the AI output is schema-invalid", async () => {
    // Wrong shape: `entries` missing entirely, `version` not literal 1.
    (callAi as unknown as Mock).mockResolvedValue({
      result: { hello: "world" },
      tokensUsed: { input: 5, output: 7 },
    });

    const res = await proposeTemplateBinding({
      templateKind: "DELIVERABLE_PRESENTATION",
      templateMimeType: DOCX_MIME,
      templateBuffer: docxBuffer,
    });

    expect(res.binding).toEqual({
      version: 1,
      templateKind: "DELIVERABLE_PRESENTATION",
      entries: [],
      notes: expect.any(String),
    });
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(
      res.warnings.some((w) => /invalid document/.test(w)),
    ).toBe(true);
    // Token totals still pass through even on validation failure.
    expect(res.tokens).toEqual({ input: 5, output: 7 });
  });

  it("returns the empty-binding fallback when the router throws", async () => {
    (callAi as unknown as Mock).mockRejectedValue(new Error("boom"));

    const res = await proposeTemplateBinding({
      templateKind: "ESTIMATION",
      templateMimeType: DOCX_MIME,
      templateBuffer: docxBuffer,
    });

    expect(res.binding.entries).toEqual([]);
    expect(res.binding.templateKind).toBe("ESTIMATION");
    expect(res.tokens).toEqual({ input: 0, output: 0 });
    expect(res.warnings.some((w) => /failed/i.test(w))).toBe(true);
  });

  it("passes the audit options through when provided", async () => {
    (callAi as unknown as Mock).mockResolvedValue({
      result: {
        version: 1,
        templateKind: "ESTIMATION",
        entries: [],
      },
      tokensUsed: { input: 1, output: 2 },
    });

    await proposeTemplateBinding({
      templateKind: "ESTIMATION",
      templateMimeType: DOCX_MIME,
      templateBuffer: docxBuffer,
      audit: { templateId: "tpl-123" },
    });

    const call = (callAi as unknown as Mock).mock.calls[0]?.[0];
    expect(call?.audit).toMatchObject({
      callType: "deliverable",
      entityType: "Template",
      entityId: "tpl-123",
    });
  });

  it("keeps section.<key> entries even when the key isn't in the engine catalog", async () => {
    // A customer-uploaded template may use any section key declared in
    // the matching deliverable-template JSON spec. The post-AI filter
    // must NOT drop those just because they're not in the closed
    // engine-field list — that would silently break the binding.
    const novelKey = "section.custom_milestone_panel";
    expect(ENGINE_OUTPUT_FIELDS as readonly string[]).not.toContain(novelKey);

    const aiBinding = {
      version: 1 as const,
      templateKind: "ROADMAP" as const,
      entries: [
        {
          field: "project.name",
          target: { kind: "docx.placeholder", token: "{{project_name}}" },
        },
        {
          field: novelKey,
          target: {
            kind: "docx.placeholder",
            token: "{{custom_milestone_panel}}",
          },
        },
      ],
    };
    (callAi as unknown as Mock).mockResolvedValue({
      result: aiBinding,
      tokensUsed: { input: 12, output: 34 },
    });

    const res = await proposeTemplateBinding({
      templateKind: "ROADMAP",
      templateMimeType: DOCX_MIME,
      templateBuffer: docxBuffer,
    });

    // Both entries survive — the section.<key> branch is open-ended.
    expect(res.binding.entries).toHaveLength(2);
    expect(res.binding.entries.map((e) => e.field)).toContain(novelKey);
    expect(res.warnings).toEqual([]);
  });

  it("passes the per-deliverable-type section catalog into the AI prompt", async () => {
    // For TemplateKind ROADMAP we ship a `roadmap.json` spec — its
    // section keys (phase_1_scope etc.) should land in the prompt so
    // the AI can bind narrative placeholders confidently.
    (callAi as unknown as Mock).mockResolvedValue({
      result: {
        version: 1,
        templateKind: "ROADMAP",
        entries: [],
      },
      tokensUsed: { input: 1, output: 1 },
    });

    await proposeTemplateBinding({
      templateKind: "ROADMAP",
      templateMimeType: DOCX_MIME,
      templateBuffer: docxBuffer,
    });

    const userContent = (callAi as unknown as Mock).mock.calls[0]?.[0]
      ?.userContent as string;
    expect(userContent).toMatch(/AI section keys/);
    expect(userContent).toMatch(/section\.phase_1_scope/);
    expect(userContent).toMatch(/section\.milestones_owners/);
  });

  it("omits the section catalog block when the TemplateKind has no spec", async () => {
    // ESTIMATION has no deliverable-template JSON — the prompt should
    // not include an empty / misleading section catalog.
    (callAi as unknown as Mock).mockResolvedValue({
      result: {
        version: 1,
        templateKind: "ESTIMATION",
        entries: [],
      },
      tokensUsed: { input: 1, output: 1 },
    });

    await proposeTemplateBinding({
      templateKind: "ESTIMATION",
      templateMimeType: DOCX_MIME,
      templateBuffer: docxBuffer,
    });

    const userContent = (callAi as unknown as Mock).mock.calls[0]?.[0]
      ?.userContent as string;
    expect(userContent).not.toMatch(/AI section keys/);
  });

  // ─── Re-propose flow ──────────────────────────────────────────────

  it("threads reviewer feedback into the AI prompt", async () => {
    // The mutation collects feedback from the textarea; the proposer
    // surfaces it under a dedicated "Reviewer feedback" block so the
    // model treats it as direction rather than buried context.
    (callAi as unknown as Mock).mockResolvedValue({
      result: {
        version: 1,
        templateKind: "ROADMAP",
        entries: [],
      },
      tokensUsed: { input: 1, output: 1 },
    });

    await proposeTemplateBinding({
      templateKind: "ROADMAP",
      templateMimeType: DOCX_MIME,
      templateBuffer: docxBuffer,
      feedback:
        "You bound {{revenue}} to project.industry — should be totals.costLow / costHigh.",
    });

    const userContent = (callAi as unknown as Mock).mock.calls[0]?.[0]
      ?.userContent as string;
    expect(userContent).toMatch(/Reviewer feedback/);
    expect(userContent).toMatch(/\{\{revenue\}\}/);
    expect(userContent).toMatch(/totals\.costLow/);
  });

  it("threads prior binding into the prompt for refine mode", async () => {
    // When a prior binding is provided the prompt MUST instruct the AI
    // to refine it (keep good entries, revisit flagged ones) rather
    // than generate from scratch. The system rule + the user-turn
    // block both must mention it.
    const priorBinding = {
      version: 1 as const,
      templateKind: "ROADMAP" as const,
      entries: [
        {
          field: "project.name",
          target: {
            kind: "docx.placeholder" as const,
            token: "{{project_name}}",
          },
        },
      ],
    };
    (callAi as unknown as Mock).mockResolvedValue({
      result: priorBinding,
      tokensUsed: { input: 1, output: 1 },
    });

    await proposeTemplateBinding({
      templateKind: "ROADMAP",
      templateMimeType: DOCX_MIME,
      templateBuffer: docxBuffer,
      priorBinding,
    });

    const userContent = (callAi as unknown as Mock).mock.calls[0]?.[0]
      ?.userContent as string;
    expect(userContent).toMatch(/Prior binding/);
    // The actual JSON appears in the prompt so the AI can read it.
    expect(userContent).toMatch(/\{\{project_name\}\}/);
  });

  it("omits the prior-binding block when fromScratch mode is in use", async () => {
    // Mutation's fromScratch=true path simply doesn't pass
    // priorBinding to the proposer — so the prompt must NOT carry a
    // "Prior binding" block (else the AI would think there's still
    // something to refine).
    (callAi as unknown as Mock).mockResolvedValue({
      result: {
        version: 1,
        templateKind: "ROADMAP",
        entries: [],
      },
      tokensUsed: { input: 1, output: 1 },
    });

    await proposeTemplateBinding({
      templateKind: "ROADMAP",
      templateMimeType: DOCX_MIME,
      templateBuffer: docxBuffer,
      feedback: "Just start over please.",
    });

    const userContent = (callAi as unknown as Mock).mock.calls[0]?.[0]
      ?.userContent as string;
    expect(userContent).not.toMatch(/Prior binding/);
    // But feedback is still threaded.
    expect(userContent).toMatch(/Just start over please\./);
  });
});
