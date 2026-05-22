import { beforeEach, describe, expect, it, vi } from "vitest";

// Integration test for the Week 3 `ingest-document` worker. Updated
// from the Week 1 version (ADR-0001) to exercise the embedding path
// (ADR-0003): extraction + recursive chunking + fake-mode embedding +
// raw-SQL Evidence insert.
//
// The three external boundaries — Prisma, MinIO, Claude — are mocked
// so the test runs in the standard Node environment without docker-
// compose. Embedding uses fake mode (no OPENAI_API_KEY in the
// environment), which produces deterministic pseudo-vectors.
//
// Two critical assertions:
//   1. Claude is never called (the Week 1 decoupling invariant, still
//      true after Week 3).
//   2. Evidence rows land with embeddings and chunk metadata via the
//      $executeRawUnsafe path, not `createMany`.

// Force fake mode deterministically for this test. Doing this *before*
// the module imports ensures `embedding-service.ts` reads the flag on
// its first call and never reaches for the OpenAI SDK.
process.env.EMBEDDING_MODE = "fake";
delete process.env.OPENAI_API_KEY;

const fixtureDocument = {
  id: "doc-test-1",
  assessmentId: "asm-test-1",
  filename: "intake-notes.txt",
  mimeType: "text/plain",
  storagePath: "asm-test-1/doc-test-1/intake-notes.txt",
};

const fixtureBuffer = Buffer.from(
  "# Intake\n\n" +
    "Intake paragraph one — stakeholders, goals.\n\n" +
    "Intake paragraph two — constraints, risks.\n\n" +
    "Intake paragraph three — success criteria.",
  "utf-8",
);

type DocRow = typeof fixtureDocument & {
  ingestStatus: string;
  processingStatus: string;
  extractedText?: string | null;
  extractedSummary?: string | null;
  chunkCount?: number | null;
};

const documents = new Map<string, DocRow>();
const evidenceInserts: Array<{ sql: string; values: unknown[] }> = [];
const auditLogs: Array<Record<string, unknown>> = [];

vi.mock("@/server/db", () => {
  const dbMock = {
    document: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return documents.get(where.id) ?? null;
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<DocRow>;
        }) => {
          const existing = documents.get(where.id);
          if (!existing) throw new Error("document not found in mock");
          const next = { ...existing, ...data };
          documents.set(where.id, next);
          return next;
        },
      ),
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        auditLogs.push(data);
        return data;
      }),
    },
    // Week 3 uses raw SQL for the Evidence insert (pgvector column).
    $executeRawUnsafe: vi.fn(async (sql: string, ...values: unknown[]) => {
      evidenceInserts.push({ sql, values });
      // Count the VALUES tuples by counting placeholders of `$1,` form.
      return values.length;
    }),
    $transaction: vi.fn(
      async (
        ops:
          | Array<Promise<unknown>>
          | ((tx: unknown) => Promise<unknown>),
      ) => {
        if (Array.isArray(ops)) {
          return Promise.all(ops);
        }
        return ops(dbMock);
      },
    ),
  };
  return { db: dbMock };
});

vi.mock("@/server/storage/minio", () => ({
  getObjectBuffer: vi.fn(async () => fixtureBuffer),
}));

// Throwing Claude mock — the load-bearing assertion. Any import path
// that tries to call Claude from the ingest job will blow up here.
const claudeSpy = vi.fn(() => {
  throw new Error("ingest-document must not call Claude (Week 1 decoupling)");
});
vi.mock("@/server/services/ai/router", () => ({
  callClaude: claudeSpy,
  callClaudeWithImage: claudeSpy,
  parseJsonResponse: claudeSpy,
  claude: new Proxy(
    {},
    {
      get: () => {
        throw new Error(
          "ingest-document touched the Anthropic SDK — it shouldn't",
        );
      },
    },
  ),
}));

import { ingestDocumentJob } from "@/server/queue/jobs/ingest-document";

beforeEach(() => {
  documents.clear();
  evidenceInserts.length = 0;
  auditLogs.length = 0;
  claudeSpy.mockClear();
  documents.set(fixtureDocument.id, {
    ...fixtureDocument,
    ingestStatus: "PENDING",
    processingStatus: "PENDING",
  });
});

describe("ingest-document job (Week 3)", () => {
  it("extracts, chunks, embeds, and writes Evidence rows without calling Claude", async () => {
    await ingestDocumentJob(fixtureDocument.id);

    // Claude was never invoked — this is the whole point.
    expect(claudeSpy).not.toHaveBeenCalled();

    const finalDoc = documents.get(fixtureDocument.id)!;
    expect(finalDoc.ingestStatus).toBe("READY");
    expect(finalDoc.processingStatus).toBe("PROCESSED");
    expect(finalDoc.chunkCount).toBeGreaterThan(0);
    expect(finalDoc.extractedText).toContain("Intake paragraph one");
    expect(finalDoc.extractedSummary).toBeTruthy();

    // Evidence rows landed via the raw-SQL path — at least one insert,
    // with a `vector(1536)` literal somewhere in the SQL.
    expect(evidenceInserts.length).toBeGreaterThan(0);
    const combined = evidenceInserts.map((i) => i.sql).join("\n");
    expect(combined).toContain("INSERT INTO \"evidences\"");
    expect(combined).toContain("::vector(1536)");

    // Audit row is the new INGEST_DOCUMENT action and it carries
    // embedding metadata — not token counts (those would imply an AI
    // call).
    const actions = auditLogs.map((a) => a.action);
    expect(actions).toContain("INGEST_DOCUMENT");
    expect(actions).not.toContain("PROCESS_DOCUMENT");
    const ingestLog = auditLogs.find((a) => a.action === "INGEST_DOCUMENT");
    const details = ingestLog!.details as Record<string, unknown>;
    expect(details.embeddingModel).toMatch(/fake/);
    expect(details.chunks).toBeGreaterThan(0);
  });

  it("marks the document FAILED when extraction yields empty text", async () => {
    documents.set(fixtureDocument.id, {
      ...fixtureDocument,
      ingestStatus: "PENDING",
      processingStatus: "PENDING",
    });
    const storage = await import("@/server/storage/minio");
    (storage.getObjectBuffer as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Buffer.from("   \n\n   "),
    );

    await expect(ingestDocumentJob(fixtureDocument.id)).rejects.toThrow();
    expect(claudeSpy).not.toHaveBeenCalled();
    const finalDoc = documents.get(fixtureDocument.id)!;
    expect(finalDoc.ingestStatus).toBe("FAILED");
    const actions = auditLogs.map((a) => a.action);
    expect(actions).toContain("INGEST_DOCUMENT_FAILED");
  });
});
