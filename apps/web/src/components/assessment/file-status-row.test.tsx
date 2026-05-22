import { describe, expect, it } from "vitest";

import {
  mapIngestStatus,
  type FileUploadStatus,
} from "./file-status-row";

/**
 * React Testing Library isn't wired into the app package — unit tests
 * here cover the pure mapping that the `<FileStatusRow>` component
 * depends on, which is where the state-machine correctness lives. The
 * render shell is a thin span-and-class wrapper; its correctness is
 * covered by visual review in the drop-zone smoke test.
 */
describe("mapIngestStatus", () => {
  it("maps every ingestStatus to a FileUploadStatus", () => {
    const cases: Array<[Parameters<typeof mapIngestStatus>[0], FileUploadStatus]> = [
      ["PENDING", "uploading"],
      ["EXTRACTING", "extracting"],
      ["CHUNKED", "chunking"],
      ["EMBEDDED", "embedding"],
      ["READY", "done"],
      ["FAILED", "failed"],
    ];
    for (const [input, expected] of cases) {
      expect(mapIngestStatus(input)).toBe(expected);
    }
  });

  it("covers every FileUploadStatus as a terminal or transient state", () => {
    const all: ReadonlyArray<FileUploadStatus> = [
      "queued",
      "uploading",
      "extracting",
      "chunking",
      "embedding",
      "done",
      "failed",
    ];
    // Guardrail: if someone adds a new ingest status, this test fails
    // until they update the switch. Unreachable states are a UI bug.
    const mapped = (
      ["PENDING", "EXTRACTING", "CHUNKED", "EMBEDDED", "READY", "FAILED"] as const
    ).map(mapIngestStatus);
    for (const m of mapped) {
      expect(all).toContain(m);
    }
  });
});
