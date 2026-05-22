import { describe, expect, it } from "vitest";

import { formatArchiveProgress } from "./archive-expansion-progress";

describe("formatArchiveProgress", () => {
  it("shows 'Uploading…' while the parent is PENDING", () => {
    expect(
      formatArchiveProgress({
        parentIngestStatus: "PENDING",
        childTotal: 0,
        childReady: 0,
        childFailed: 0,
      }),
    ).toBe("Uploading…");
  });

  it("shows a generic extracting message before any children exist", () => {
    expect(
      formatArchiveProgress({
        parentIngestStatus: "EXTRACTING",
        childTotal: 0,
        childReady: 0,
        childFailed: 0,
      }),
    ).toBe("Extracting archive…");
  });

  it("shows the queued child count while extraction is in flight", () => {
    expect(
      formatArchiveProgress({
        parentIngestStatus: "EXTRACTING",
        childTotal: 247,
        childReady: 0,
        childFailed: 0,
      }),
    ).toBe("Extracting: 247 children queued");
  });

  it("shows ingest progress after extraction completes", () => {
    expect(
      formatArchiveProgress({
        parentIngestStatus: "READY",
        childTotal: 247,
        childReady: 183,
        childFailed: 0,
      }),
    ).toBe("Ingested 183 / 247 files");
  });

  it("reports the terminal ingested/failed split", () => {
    expect(
      formatArchiveProgress({
        parentIngestStatus: "READY",
        childTotal: 100,
        childReady: 97,
        childFailed: 3,
      }),
    ).toBe("Ready · 97 of 100 ingested (3 failed)");
  });

  it("reports clean terminal when all children succeed", () => {
    expect(
      formatArchiveProgress({
        parentIngestStatus: "READY",
        childTotal: 50,
        childReady: 50,
        childFailed: 0,
      }),
    ).toBe("Ready · 50 of 50 ingested");
  });

  it("reports a clean parent failure", () => {
    expect(
      formatArchiveProgress({
        parentIngestStatus: "FAILED",
        childTotal: 0,
        childReady: 0,
        childFailed: 0,
      }),
    ).toBe("Failed to extract archive");
  });

  it("handles archives that had nothing to ingest", () => {
    expect(
      formatArchiveProgress({
        parentIngestStatus: "READY",
        childTotal: 0,
        childReady: 0,
        childFailed: 0,
      }),
    ).toBe("Extracted (no ingestable files)");
  });
});
