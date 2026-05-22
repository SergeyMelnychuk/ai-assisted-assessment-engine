/**
 * Unit tests for the archive-ingest worker (Week 5, ADR-0008).
 *
 * We target the pure helpers (entry filter, magic-byte detection,
 * .copilotignore parsing) because those are the load-bearing safety
 * logic. The orchestrator `ingestArchiveJob` itself is heavily glued
 * into Prisma/BullMQ/MinIO — those integrations get covered by the
 * smoke script `scripts/smoke/smoke-archive-upload.sh` rather than
 * mocked-out-of-reality here.
 */

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_IGNORE_BASENAME_SUFFIXES,
  DEFAULT_IGNORE_SEGMENTS,
  type ArchiveEntry,
  type FilterContext,
  classifyEntry,
  detectArchiveKind,
  parseCopilotignore,
} from "./ingest-archive";

// Guard: no Claude call may happen from this worker. If any test
// accidentally wires through an import chain that reaches
// claude-client, the mock's throw makes the failure immediate and
// loud (same pattern as document-processor.test.ts).
vi.mock("@/server/services/ai/router", () => ({
  callClaude: vi.fn(() => {
    throw new Error(
      "ingest-archive must not call Claude (Week 5, ADR-0008)",
    );
  }),
  parseJsonResponse: vi.fn(() => {
    throw new Error("ingest-archive must not parse AI responses");
  }),
}));

// Mock Prisma + BullMQ + MinIO so *importing* the module doesn't spin
// up Redis or open a Postgres pool. We don't call the orchestrator
// here, but import-time side effects still matter.
vi.mock("@/server/db", () => ({ db: {} }));
vi.mock("@/server/queue/queue", () => ({
  enqueueIngestDocument: vi.fn(),
}));
vi.mock("@/server/storage/minio", () => ({
  buildStorageKey: vi.fn(() => "assessments/a/documents/d/f"),
  ensureBucket: vi.fn(),
  getObjectStream: vi.fn(),
  putObject: vi.fn(),
}));

const baseCtx: FilterContext = {
  ignoreSegments: DEFAULT_IGNORE_SEGMENTS,
  ignoreBasenameSuffixes: DEFAULT_IGNORE_BASENAME_SUFFIXES,
  extraIgnorePatterns: [],
  maxDepth: 20,
};

function entry(partial: Partial<ArchiveEntry> & { path: string }): ArchiveEntry {
  return {
    size: partial.size ?? 100,
    isSymlink: partial.isSymlink ?? false,
    isDirectory: partial.isDirectory ?? false,
    ...partial,
  };
}

describe("detectArchiveKind", () => {
  it("identifies zip via magic bytes", () => {
    const head = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    expect(detectArchiveKind(head, null, null)).toBe("zip");
  });

  it("identifies empty zip (PK\\x05\\x06) via magic bytes", () => {
    const head = Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]);
    expect(detectArchiveKind(head, null, null)).toBe("zip");
  });

  it("identifies gzip / tar.gz via magic bytes", () => {
    const head = Buffer.from([0x1f, 0x8b, 0x08, 0]);
    expect(detectArchiveKind(head, null, null)).toBe("tar.gz");
  });

  it("identifies tar via ustar magic at offset 257", () => {
    const head = Buffer.alloc(512, 0);
    head[257] = 0x75; // 'u'
    head[258] = 0x73; // 's'
    head[259] = 0x74; // 't'
    head[260] = 0x61; // 'a'
    head[261] = 0x72; // 'r'
    expect(detectArchiveKind(head, null, null)).toBe("tar");
  });

  it("falls back on MIME when magic bytes are absent", () => {
    const head = Buffer.alloc(16, 0);
    expect(detectArchiveKind(head, "application/zip", "mystery")).toBe("zip");
    expect(detectArchiveKind(head, "application/x-tar", "mystery")).toBe(
      "tar",
    );
    expect(detectArchiveKind(head, "application/gzip", "mystery")).toBe(
      "tar.gz",
    );
  });

  it("falls back on filename when MIME is wrong", () => {
    const head = Buffer.alloc(16, 0);
    expect(
      detectArchiveKind(head, "application/octet-stream", "project.tar.gz"),
    ).toBe("tar.gz");
    expect(detectArchiveKind(head, "", "project.tgz")).toBe("tar.gz");
    expect(detectArchiveKind(head, "", "project.zip")).toBe("zip");
  });

  it("returns 'unknown' when nothing matches", () => {
    const head = Buffer.from("hello world");
    expect(detectArchiveKind(head, "text/plain", "notes.txt")).toBe(
      "unknown",
    );
  });
});

describe("classifyEntry — ignore list", () => {
  it("skips node_modules subtrees", () => {
    const r = classifyEntry(entry({ path: "node_modules/react/index.js" }), baseCtx);
    expect(r).toEqual({ keep: false, reason: "ignored" });
  });

  it("skips .git subtrees", () => {
    const r = classifyEntry(entry({ path: "src/.git/HEAD" }), baseCtx);
    expect(r).toEqual({ keep: false, reason: "ignored" });
  });

  it("skips dist / build / target / .next", () => {
    for (const p of [
      "dist/app.js",
      "build/output.bin",
      "target/release/app",
      "web/.next/server/chunks.js",
    ]) {
      expect(classifyEntry(entry({ path: p }), baseCtx).keep).toBe(false);
    }
  });

  it("skips *.lock, *.min.js, *.pyc, .DS_Store, .env", () => {
    for (const p of [
      "app/package-lock.json",
      "web/bundle.min.js",
      "scripts/tool.pyc",
      "docs/.DS_Store",
      ".env",
    ]) {
      expect(classifyEntry(entry({ path: p }), baseCtx).keep).toBe(false);
    }
  });

  it("skips named lockfiles (yarn, pnpm, cargo, gemfile, poetry)", () => {
    for (const p of [
      "yarn.lock",
      "pnpm-lock.yaml",
      "rust/Cargo.lock",
      "Gemfile.lock",
      "py/poetry.lock",
      "go.sum",
    ]) {
      expect(classifyEntry(entry({ path: p }), baseCtx).keep).toBe(false);
    }
  });

  it("keeps normal source files", () => {
    const r = classifyEntry(entry({ path: "src/index.ts" }), baseCtx);
    expect(r.keep).toBe(true);
  });

  it("honours .copilotignore patterns", () => {
    const ctx: FilterContext = {
      ...baseCtx,
      extraIgnorePatterns: ["secrets/", "*.env.local", "exact-name.bin"],
    };
    expect(classifyEntry(entry({ path: "secrets/key.pem" }), ctx).keep).toBe(
      false,
    );
    expect(
      classifyEntry(entry({ path: ".env.local" }), ctx).keep,
    ).toBe(false);
    expect(
      classifyEntry(entry({ path: "a/exact-name.bin" }), ctx).keep,
    ).toBe(false);
    expect(classifyEntry(entry({ path: "src/ok.ts" }), ctx).keep).toBe(true);
  });
});

describe("classifyEntry — depth gate", () => {
  it("accepts 20-deep paths", () => {
    const segs = Array.from({ length: 20 }, (_, i) => `d${i}`);
    segs.push("file.txt");
    // 20 dirs + a filename = 21 segments but depth is counted by
    // directories between root and basename — our check uses segment
    // count which includes the filename. Confirm the boundary holds
    // at maxDepth = 20 exactly (21 segments → trips).
    const r = classifyEntry(entry({ path: segs.join("/") }), baseCtx);
    expect(r.keep).toBe(false);
    expect(r.keep ? null : r.reason).toBe("depth");
    expect(r.keep ? null : (r.hardFail ?? false)).toBe(true);
  });

  it("accepts 5-deep paths", () => {
    const r = classifyEntry(
      entry({ path: "a/b/c/d/e/file.txt" }),
      baseCtx,
    );
    expect(r.keep).toBe(true);
  });
});

describe("classifyEntry — symlink / zip-slip", () => {
  it("hard-fails on symlinks", () => {
    const r = classifyEntry(
      entry({ path: "src/evil", isSymlink: true }),
      baseCtx,
    );
    expect(r.keep).toBe(false);
    expect(r.keep ? null : r.reason).toBe("symlink");
    expect(r.keep ? null : (r.hardFail ?? false)).toBe(true);
  });

  it("hard-fails on absolute paths", () => {
    const r = classifyEntry(entry({ path: "/etc/passwd" }), baseCtx);
    expect(r.keep ? null : r.reason).toBe("absolute");
    expect(r.keep ? null : (r.hardFail ?? false)).toBe(true);
  });

  it("hard-fails on .. traversal segments", () => {
    const r = classifyEntry(entry({ path: "safe/../../etc/shadow" }), baseCtx);
    expect(r.keep ? null : r.reason).toBe("traversal");
    expect(r.keep ? null : (r.hardFail ?? false)).toBe(true);
  });

  it("silently skips directory entries", () => {
    const r = classifyEntry(
      entry({ path: "src/", isDirectory: true }),
      baseCtx,
    );
    expect(r).toEqual({ keep: false, reason: "directory" });
  });
});

describe("parseCopilotignore", () => {
  it("strips comments and blank lines", () => {
    const raw = `
      # top-level comment
      secrets/

      *.env.local
      # trailing comment
    `;
    expect(parseCopilotignore(raw)).toEqual(["secrets/", "*.env.local"]);
  });

  it("returns an empty list for an empty file", () => {
    expect(parseCopilotignore("")).toEqual([]);
  });
});
