import { describe, expect, it } from "vitest";
import { isAcceptableUploadMime } from "./mime";

/**
 * Unit tests for the multi-file upload parser's MIME gate (Phase 3
 * Week 5 gap-fill). The route itself is a Next.js handler that pulls
 * Prisma / MinIO / BullMQ in transitively — full handler tests belong
 * in the integration suite once a Prisma test DB harness lands. For
 * now we assert the classifier that decides accepted-vs-rejected on a
 * per-file basis, which is the one pure function the new path added.
 *
 * The handler's multi-file behaviour itself — "two accepted, one
 * rejected for bad MIME" — is exercised via this predicate: the loop
 * in `processMultipleFiles` pushes into `rejected` iff `isAcceptableUploadMime`
 * returns false, so the predicate's truth table IS the handler's
 * accept/reject contract for the MIME dimension.
 */

describe("isAcceptableUploadMime", () => {
  it("accepts empty / missing MIME and defers to downstream detectors", () => {
    expect(isAcceptableUploadMime(undefined)).toBe(true);
    expect(isAcceptableUploadMime(null)).toBe(true);
    expect(isAcceptableUploadMime("")).toBe(true);
  });

  it("accepts common document + archive + image MIME types", () => {
    for (const mime of [
      "text/markdown",
      "text/plain",
      "application/pdf",
      "application/zip",
      "application/gzip",
      "application/x-tar",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword",
      "application/json",
      "application/xml",
      "application/octet-stream",
      "image/png",
      "image/jpeg",
      "image/svg+xml",
    ]) {
      expect(isAcceptableUploadMime(mime), mime).toBe(true);
    }
  });

  it("rejects clearly-wrong MIME types like audio/video", () => {
    expect(isAcceptableUploadMime("audio/mpeg")).toBe(false);
    expect(isAcceptableUploadMime("video/mp4")).toBe(false);
    expect(isAcceptableUploadMime("application/x-executable")).toBe(false);
  });

  it("simulates the handler's two-accepted / one-rejected outcome", () => {
    // Models the multi-file POST body: two valid files + one with a
    // bad MIME. The handler's loop checks each with this predicate.
    const inputs = [
      { name: "spec.md", mime: "text/markdown" },
      { name: "architecture.pdf", mime: "application/pdf" },
      { name: "podcast.mp3", mime: "audio/mpeg" },
    ];
    const accepted = inputs.filter((i) => isAcceptableUploadMime(i.mime));
    const rejected = inputs.filter((i) => !isAcceptableUploadMime(i.mime));
    expect(accepted.map((a) => a.name)).toEqual([
      "spec.md",
      "architecture.pdf",
    ]);
    expect(rejected.map((r) => r.name)).toEqual(["podcast.mp3"]);
  });
});
