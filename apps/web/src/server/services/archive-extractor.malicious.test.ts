/**
 * Malicious-fixture integration test for the archive extractor (Phase 3
 * Week 5 gap-fill — the integration-test checkbox in
 * `docs/design/phase-3-roadmap.md`).
 *
 * Why this file lives under `services/` rather than under
 * `workers/ingest-archive.test.ts`:
 *   - The worker unit test already covers the pure `classifyEntry`
 *     happy-path. This file is the adversarial complement — one test
 *     per documented attack class, each asserting the extractor's
 *     validation hook produces the ARCHIVE_* category the classifier
 *     expects.
 *   - We deliberately do NOT execute the orchestrator. Real extraction
 *     needs MinIO + Postgres + Redis, which lives in the smoke script
 *     (`scripts/smoke/smoke-archive-upload.sh`). Here we drive the
 *     validation contract directly with synthetic entries.
 *
 * Coverage:
 *   - Oversized zip (> declared MAX_UNCOMPRESSED) → `ARCHIVE_SIZE_LIMIT`
 *   - Zip-slip (`../../etc/passwd`)               → `ARCHIVE_MALFORMED`
 *                                                    (path traversal is
 *                                                    caught by entry
 *                                                    classifier as
 *                                                    `traversal` →
 *                                                    hardFail; when
 *                                                    the worker throws
 *                                                    `ARCHIVE_MALFORMED`
 *                                                    with entryPath
 *                                                    suffix, the
 *                                                    classifier maps
 *                                                    it through
 *                                                    `ARCHIVE_MALFORMED`.)
 *   - Deeply-nested (> MAX_DEPTH)                 → `ARCHIVE_DEPTH_LIMIT`
 *   - Symlink entries                             → `ARCHIVE_SYMLINK`
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db", () => ({ db: {} }));
vi.mock("@/server/queue/queue", () => ({
  enqueueIngestDocument: vi.fn(),
}));
vi.mock("@/server/storage/minio", () => ({
  ensureBucket: vi.fn(),
  getObjectStream: vi.fn(),
  putObject: vi.fn(),
}));

import {
  ArchiveSafetyError,
  DEFAULT_IGNORE_BASENAME_SUFFIXES,
  DEFAULT_IGNORE_SEGMENTS,
  classifyEntry,
  type FilterContext,
} from "@/server/workers/ingest-archive";
import { classifyProcessingError } from "@/server/services/ai/error-classifier";

const ctx: FilterContext = {
  ignoreSegments: DEFAULT_IGNORE_SEGMENTS,
  ignoreBasenameSuffixes: DEFAULT_IGNORE_BASENAME_SUFFIXES,
  extraIgnorePatterns: [],
  maxDepth: 10,
};

describe("archive extractor — malicious inputs", () => {
  it("rejects oversized archives with ARCHIVE_SIZE_LIMIT", () => {
    // The size gate is enforced during streaming, not per-entry, so we
    // drive it directly via the ArchiveSafetyError the worker throws
    // and assert the classifier routes it to ARCHIVE_SIZE_LIMIT.
    const err = new ArchiveSafetyError(
      "ARCHIVE_SIZE_LIMIT",
      "uncompressed bytes exceeded 500 MB (observed 742 MB)",
    );
    const classified = classifyProcessingError(err);
    expect(classified.category).toBe("ARCHIVE_SIZE_LIMIT");
    expect(classified.isRetryable).toBe(false);
  });

  it("rejects zip-slip `../../etc/passwd` entries as hard-fail traversal", () => {
    const result = classifyEntry(
      {
        path: "../../etc/passwd",
        size: 12,
        isSymlink: false,
        isDirectory: false,
      },
      ctx,
    );
    expect(result.keep).toBe(false);
    // The filter flags this as `traversal` with hardFail — which the
    // worker surfaces as ARCHIVE_MALFORMED through its extract loop.
    if (!result.keep) {
      expect(result.reason).toBe("traversal");
      expect(result.hardFail).toBe(true);
    }
    const classified = classifyProcessingError(
      new ArchiveSafetyError(
        "ARCHIVE_MALFORMED",
        "path traversal detected",
        "../../etc/passwd",
      ),
    );
    expect(classified.category).toBe("ARCHIVE_MALFORMED");
  });

  it("rejects absolute paths as hard-fail", () => {
    const result = classifyEntry(
      {
        path: "/etc/shadow",
        size: 1,
        isSymlink: false,
        isDirectory: false,
      },
      ctx,
    );
    expect(result.keep).toBe(false);
    if (!result.keep) {
      expect(result.reason).toBe("absolute");
      expect(result.hardFail).toBe(true);
    }
  });

  it("rejects deeply-nested entries (> maxDepth) with ARCHIVE_DEPTH_LIMIT", () => {
    const deep = Array.from({ length: 15 }, (_, i) => `d${i}`).join("/");
    const result = classifyEntry(
      {
        path: `${deep}/hit.txt`,
        size: 10,
        isSymlink: false,
        isDirectory: false,
      },
      ctx,
    );
    expect(result.keep).toBe(false);
    if (!result.keep) {
      expect(result.reason).toBe("depth");
      expect(result.hardFail).toBe(true);
    }
    const classified = classifyProcessingError(
      new ArchiveSafetyError(
        "ARCHIVE_DEPTH_LIMIT",
        "entry path exceeded max depth of 10",
        `${deep}/hit.txt`,
      ),
    );
    expect(classified.category).toBe("ARCHIVE_DEPTH_LIMIT");
  });

  it("rejects symlink entries with ARCHIVE_SYMLINK", () => {
    const result = classifyEntry(
      {
        path: "link-to-passwd",
        size: 0,
        isSymlink: true,
        isDirectory: false,
      },
      ctx,
    );
    expect(result.keep).toBe(false);
    if (!result.keep) {
      expect(result.reason).toBe("symlink");
      expect(result.hardFail).toBe(true);
    }
    const classified = classifyProcessingError(
      new ArchiveSafetyError(
        "ARCHIVE_SYMLINK",
        "symlink entries are rejected as a zip-slip defence",
        "link-to-passwd",
      ),
    );
    expect(classified.category).toBe("ARCHIVE_SYMLINK");
  });

  it("rejects archives that exceed the per-archive entry limit", () => {
    const err = new ArchiveSafetyError(
      "ARCHIVE_ENTRY_LIMIT",
      "archive contains more than 10000 entries",
    );
    const classified = classifyProcessingError(err);
    expect(classified.category).toBe("ARCHIVE_ENTRY_LIMIT");
    expect(classified.isRetryable).toBe(false);
  });

  it("every ARCHIVE_* error is non-retryable (user must re-archive)", () => {
    const tags = [
      "ARCHIVE_ENTRY_LIMIT",
      "ARCHIVE_SIZE_LIMIT",
      "ARCHIVE_DEPTH_LIMIT",
      "ARCHIVE_SYMLINK",
      "ARCHIVE_MALFORMED",
    ] as const;
    for (const tag of tags) {
      const classified = classifyProcessingError(
        new ArchiveSafetyError(tag, "test"),
      );
      expect(classified.isRetryable, `${tag} should be non-retryable`).toBe(
        false,
      );
    }
  });
});
