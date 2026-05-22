import { beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";

// ─── Storage mock — captures putObject and serves the fixture ──────
//
// We intercept the MinIO module so the test never reaches the real S3
// client. `getObjectBuffer` returns the in-test xlsx fixture; every
// `putObject` call is recorded into a Map so we can assert what the
// pipeline wrote.

const minioStore = new Map<string, { body: Buffer; contentType: string }>();
let templateBuffer: Buffer = Buffer.alloc(0);

vi.mock("@/server/storage/minio", async () => {
  const actual = await vi.importActual<{
    buildStorageKey: (a: string, b: string, c: string) => string;
  }>("@/server/storage/minio");
  return {
    buildStorageKey: actual.buildStorageKey,
    getObjectBuffer: vi.fn(async (key: string) => {
      // Template fetch: return the fixture. Anything else: lookup the
      // captured store (defensive — the fill path doesn't read its own
      // outputs in this test).
      if (key.startsWith("templates/")) return templateBuffer;
      const hit = minioStore.get(key);
      if (!hit) throw new Error(`no object: ${key}`);
      return hit.body;
    }),
    putObject: vi.fn(
      async (key: string, body: Buffer, contentType: string) => {
        minioStore.set(key, { body, contentType });
      },
    ),
  };
});

import {
  fillAndStoreForAssessment,
} from "./fill-and-store";
import { putObject } from "@/server/storage/minio";

// ─── Build a minimal xlsx the filler can populate ──────────────────

async function buildXlsxFixture(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Cover");
  sheet.getCell("A1").value = "Project";
  sheet.getCell("B1").value = "PLACEHOLDER";
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const VALID_BINDING = {
  version: 1 as const,
  templateKind: "ESTIMATION" as const,
  entries: [
    {
      field: "project.name",
      target: { kind: "xlsx.cell" as const, sheet: "Cover", cell: "B1" },
    },
  ],
};

// ─── In-memory Prisma stub ─────────────────────────────────────────

interface World {
  templates: Map<string, Record<string, unknown>>;
  assessments: Map<string, Record<string, unknown>>;
  documents: Map<string, Record<string, unknown>>;
  fills: Map<string, Record<string, unknown>>;
  audits: Array<Record<string, unknown>>;
  members: Array<{ engagementId: string; userId: string; role: string }>;
  documentCreateCalls: Array<Record<string, unknown>>;
  fillCreateCalls: Array<Record<string, unknown>>;
}

function makeDb(world: World) {
  // Sequence id for created docs/fills.
  let seq = 1;
  return {
    template: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        return world.templates.get(args.where.id) ?? null;
      }),
      findFirst: vi.fn(async (args: { where: { id?: string } }) => {
        // Only used by the explicit-templateId override branch.
        if (args.where.id) {
          const t = world.templates.get(args.where.id);
          return t ?? null;
        }
        return null;
      }),
      findMany: vi.fn(async () => {
        // resolveTemplateForAssessment — return APPROVED + non-archived
        // + binding-present rows.
        return Array.from(world.templates.values()).filter(
          (t) =>
            t.status === "APPROVED" &&
            t.archivedAt === null &&
            t.bindingJson !== null,
        );
      }),
    },
    assessment: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        return world.assessments.get(args.where.id) ?? null;
      }),
    },
    engagementMember: {
      findFirst: vi.fn(
        async (args: { where: { engagementId: string; role: string } }) => {
          return (
            world.members.find(
              (m) =>
                m.engagementId === args.where.engagementId &&
                m.role === args.where.role,
            ) ?? null
          );
        },
      ),
    },
    document: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        world.documentCreateCalls.push(args.data);
        const id = `doc-${seq++}`;
        const row = { id, ...args.data };
        world.documents.set(id, row);
        return { id };
      }),
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const cur = world.documents.get(args.where.id);
          if (!cur) throw new Error("doc not found");
          const next = { ...cur, ...args.data };
          world.documents.set(args.where.id, next);
          return next;
        },
      ),
      delete: vi.fn(async (args: { where: { id: string } }) => {
        world.documents.delete(args.where.id);
        return null;
      }),
    },
    templateFill: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        world.fillCreateCalls.push(args.data);
        const id = `fill-${seq++}`;
        world.fills.set(id, { id, ...args.data });
        return { id };
      }),
    },
    auditLog: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        world.audits.push(args.data);
        return args.data;
      }),
    },
  };
}

// ─── Test world setup ──────────────────────────────────────────────

async function setupWorld(): Promise<World> {
  templateBuffer = await buildXlsxFixture();
  return {
    templates: new Map([
      [
        "tpl-1",
        {
          id: "tpl-1",
          engagementId: null,
          kind: "ESTIMATION",
          name: "WBS",
          version: "1.0",
          filename: "wbs.xlsx",
          mimeType: XLSX_MIME,
          fileSize: templateBuffer.byteLength,
          status: "APPROVED",
          archivedAt: null,
          approvedAt: new Date(),
          storagePath: "templates/tpl-1/wbs.xlsx",
          bindingJson: VALID_BINDING,
        },
      ],
    ]),
    assessments: new Map([
      [
        "asm-1",
        {
          id: "asm-1",
          engagementId: "eng-1",
          activeDomains: [],
          // engine-outputs.findUnique pulls these joined relations.
          engagement: { name: "Acme", clientName: "Acme Corp" },
          projectContext: {
            projectName: "Acme Migration",
            industry: "Finance",
            description: "",
            businessGoals: "",
            expectedTimeline: "",
            budgetSensitivity: "",
            complianceRequirements: [],
          },
        },
      ],
    ]),
    documents: new Map(),
    fills: new Map(),
    audits: [],
    members: [{ engagementId: "eng-1", userId: "u-owner", role: "OWNER" }],
    documentCreateCalls: [],
    fillCreateCalls: [],
  };
}

// engine-outputs.loadEngineOutputs also queries roleProposal, estimate,
// finding, risk, recommendation. Stub those onto the same db object.
function attachEngineOutputStubs(
  db: ReturnType<typeof makeDb>,
): ReturnType<typeof makeDb> & Record<string, unknown> {
  return Object.assign(db, {
    roleProposal: {
      findMany: vi.fn(async () => [
        {
          roleName: "PM",
          seniority: "Senior",
          count: 1,
          phase: null,
          justification: "",
          responsibilities: "",
        },
      ]),
    },
    estimate: {
      findFirst: vi.fn(async () => ({
        totalEffortHoursLow: 100,
        totalEffortHoursHigh: 120,
        totalCostLow: 20000,
        totalCostHigh: 24000,
        scenarioName: "Default",
        assumptions: "",
        confidence: 0.7,
        rateCard: { currency: "USD" },
      })),
    },
    finding: { findMany: vi.fn(async () => []) },
    risk: { findMany: vi.fn(async () => []) },
    recommendation: { findMany: vi.fn(async () => []) },
  });
}

beforeEach(() => {
  minioStore.clear();
  vi.clearAllMocks();
});

describe("fillAndStoreForAssessment (integration)", () => {
  it("walks the happy path: resolve template → fill xlsx → write Document + TemplateFill → write to MinIO", async () => {
    const world = await setupWorld();
    const db = attachEngineOutputStubs(makeDb(world));

    const result = await fillAndStoreForAssessment(
      db as never,
      {
        assessmentId: "asm-1",
        kind: "ESTIMATION",
        actingUserId: "u-owner",
      },
    );

    expect(result).not.toBeNull();
    expect(result!.documentId).toMatch(/^doc-/);
    expect(result!.templateFillId).toMatch(/^fill-/);
    expect(result!.filename).toContain("wbs");
    expect(result!.filename).toMatch(/\.xlsx$/);

    // Document.create called with the right shape.
    expect(world.documentCreateCalls).toHaveLength(1);
    const docCreate = world.documentCreateCalls[0]!;
    expect(docCreate).toMatchObject({
      assessmentId: "asm-1",
      mimeType: XLSX_MIME,
      uploadType: "OTHER",
      ingestStatus: "READY",
      processingStatus: "PROCESSED",
      uploadedById: "u-owner",
    });
    expect(typeof docCreate.fileSize).toBe("number");
    expect(docCreate.fileSize).toBeGreaterThan(0);

    // TemplateFill.create called with snapshots.
    expect(world.fillCreateCalls).toHaveLength(1);
    const fillCreate = world.fillCreateCalls[0]!;
    expect(fillCreate).toMatchObject({
      templateId: "tpl-1",
      assessmentId: "asm-1",
      filledById: "u-owner",
    });
    expect(fillCreate.bindingSnapshot).toBeDefined();
    expect(fillCreate.inputsSnapshot).toBeDefined();
    expect(fillCreate.outputDocumentId).toBeDefined();

    // putObject was invoked once with a non-empty buffer.
    expect(putObject).toHaveBeenCalledTimes(1);
    const put = (putObject as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]!;
    const writtenBuffer = put[1] as Buffer;
    expect(Buffer.isBuffer(writtenBuffer)).toBe(true);
    expect(writtenBuffer.byteLength).toBeGreaterThan(0);
    expect(put[2]).toBe(XLSX_MIME);

    // Round-trip: parse the written buffer and confirm B1 was populated
    // from the binding (project.name → "Acme Migration").
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(writtenBuffer as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet("Cover");
    expect(sheet).toBeDefined();
    expect(sheet!.getCell("B1").value).toBe("Acme Migration");

    // TEMPLATE_FILLED audit row landed.
    expect(world.audits.some((a) => a.action === "TEMPLATE_FILLED")).toBe(true);
  });

  it("returns null and writes a TEMPLATE_FILL_FAILED audit when bindingJson is malformed", async () => {
    const world = await setupWorld();
    // Corrupt the binding so schema validation fails.
    const t = world.templates.get("tpl-1")!;
    t.bindingJson = { totally: "bogus" };
    const db = attachEngineOutputStubs(makeDb(world));

    const result = await fillAndStoreForAssessment(db as never, {
      assessmentId: "asm-1",
      kind: "ESTIMATION",
      actingUserId: "u-owner",
    });

    expect(result).toBeNull();
    expect(world.documentCreateCalls).toHaveLength(0);
    expect(world.fillCreateCalls).toHaveLength(0);
    expect(
      world.audits.some(
        (a) =>
          a.action === "TEMPLATE_FILL_FAILED" &&
          (a.details as { reason?: string }).reason ===
            "binding_schema_invalid",
      ),
    ).toBe(true);
  });
});
