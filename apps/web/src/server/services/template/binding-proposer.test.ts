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
});
