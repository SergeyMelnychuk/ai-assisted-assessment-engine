/**
 * Nock-like tests for `GitHubProvider.fetchTarball` (Phase 3 Week 6).
 *
 * We don't pull in `nock` — injecting a fake `fetch` keeps the
 * surface small and the test fast. The provider's constructor takes
 * a fetch override exactly to avoid a network mock library.
 *
 * What we cover:
 *   - 200 happy path: the tarball streams into MinIO under the
 *     expected key, SHA is picked up from the header, no PAT leak
 *     in any arg passed to `putObject`.
 *   - 401 → REPO_AUTH_FAILED.
 *   - 404 → REPO_NOT_FOUND.
 *   - 403 + `x-ratelimit-remaining: 0` → REPO_RATE_LIMITED.
 *   - Oversize content-length → REPO_TARBALL_TOO_LARGE before any
 *     put call happens.
 *
 * Also the secret-scan assertion: across the entire interaction
 * (fetch args, S3 args, anything we log) the test PAT must never
 * appear. Any regression flips that assertion red.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { GitHubProvider } from "./github-provider";

const TEST_PAT = "ghp_TESTABCDEFGHIJKLMNOPQRSTUVWXYZ01";

// Encrypt the PAT so the RepositoryLink shape is realistic. We bypass
// the real key resolution by flipping fake mode on.
process.env.REPO_CREDENTIAL_MODE = "fake";
delete process.env.REPO_CREDENTIAL_KEY;

// Mock S3 so nothing hits the network; capture every call for the
// secret-scan check.
const s3Sends: Array<{ input: unknown }> = [];
vi.mock("@/server/storage/minio", () => ({
  BUCKET: "test-bucket",
  ensureBucket: vi.fn(async () => {}),
  s3: {
    send: vi.fn(async (cmd: unknown) => {
      s3Sends.push({ input: (cmd as { input: unknown }).input });
      // Drain the body stream so the provider doesn't hang.
      const body = (cmd as { input: { Body?: { on: Function } } }).input.Body;
      if (body && typeof (body as { on?: unknown }).on === "function") {
        await new Promise<void>((resolve) => {
          (body as NodeJS.ReadableStream).on("data", () => {});
          (body as NodeJS.ReadableStream).on("end", () => resolve());
          (body as NodeJS.ReadableStream).on("error", () => resolve());
        });
      }
      return {};
    }),
  },
}));

// The PAT now arrives via the engagement-scoped credential vault;
// the link itself no longer carries one. The test passes the PAT as
// the second argument to fetchTarball, mirroring how the ingest worker
// calls the provider in production.

function makeLink() {
  return {
    id: "link-abc",
    assessmentId: "asm-test",
    url: "https://github.com/acme/platform",
    provider: "github",
    authMethod: "pat",
    agentCredentialId: "cred-1",
    lastSyncedAt: null,
    lastSha: null,
    ingestStatus: "PENDING" as const,
    parentDocumentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function buildResponse(opts: {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: ReadableStream<Uint8Array> | null;
}): Response {
  const headers = new Headers(opts.headers ?? {});
  return new Response(opts.body ?? null, {
    status: opts.status,
    statusText: opts.statusText ?? "",
    headers,
  });
}

function streamOfChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i]);
      i += 1;
    },
  });
}

describe("GitHubProvider.fetchTarball", () => {
  beforeEach(() => {
    s3Sends.length = 0;
  });

  it("streams a 200 tarball to MinIO and reports the commit SHA", async () => {
    const sha = "abcdef1234567890abcdef1234567890abcdef12";
    const chunks = [
      new Uint8Array([0x1f, 0x8b, 0x08, 0x00]),
      new Uint8Array([1, 2, 3, 4, 5]),
    ];
    const fakeFetch = vi.fn(
      async () =>
        buildResponse({
          status: 200,
          headers: {
            "x-github-repository-commit-sha": sha,
            "content-length": "9",
          },
          body: streamOfChunks(chunks),
        }),
    );
    const provider = new GitHubProvider(
      fakeFetch as unknown as typeof fetch,
    );
    const result = await provider.fetchTarball(makeLink(), TEST_PAT);

    expect(result.sha).toBe(sha);
    expect(result.byteLength).toBe(9);
    expect(result.s3Key).toMatch(/^repo-archives\/link-abc\/.*\.tar\.gz$/);

    // Secret-scan: PAT must not appear in anything we PERSIST (S3
    // payloads). The Authorization header on the outbound fetch is
    // the only legitimate place the PAT travels — that's covered
    // separately by the assertion below.
    const persistedInteractions = JSON.stringify({ s3Sends });
    expect(persistedInteractions).not.toContain(TEST_PAT);

    // And the PAT *must* be in the Authorization header that was
    // sent — i.e. we actually decrypt + pass it to GitHub.
    const firstCall = fakeFetch.mock.calls[0] as unknown as
      | [RequestInfo | URL, RequestInit?]
      | undefined;
    const headers = ((firstCall?.[1] ?? {}) as RequestInit).headers as
      | Record<string, string>
      | undefined;
    expect(headers?.Authorization).toBe(`Bearer ${TEST_PAT}`);
  });

  it("maps 401 to REPO_AUTH_FAILED", async () => {
    const fakeFetch = vi.fn(
      async () => buildResponse({ status: 401, body: streamOfChunks([]) }),
    );
    const provider = new GitHubProvider(
      fakeFetch as unknown as typeof fetch,
    );
    await expect(provider.fetchTarball(makeLink(), TEST_PAT)).rejects.toThrow(
      /REPO_AUTH_FAILED/,
    );
  });

  it("maps 404 to REPO_NOT_FOUND", async () => {
    const fakeFetch = vi.fn(
      async () => buildResponse({ status: 404, body: streamOfChunks([]) }),
    );
    const provider = new GitHubProvider(
      fakeFetch as unknown as typeof fetch,
    );
    await expect(provider.fetchTarball(makeLink(), TEST_PAT)).rejects.toThrow(
      /REPO_NOT_FOUND/,
    );
  });

  it("maps 403 + remaining=0 to REPO_RATE_LIMITED", async () => {
    const fakeFetch = vi.fn(
      async () =>
        buildResponse({
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "retry-after": "120",
          },
          body: streamOfChunks([]),
        }),
    );
    const provider = new GitHubProvider(
      fakeFetch as unknown as typeof fetch,
    );
    await expect(provider.fetchTarball(makeLink(), TEST_PAT)).rejects.toThrow(
      /REPO_RATE_LIMITED/,
    );
  });

  it("rejects oversize content-length before any S3 put happens", async () => {
    const fakeFetch = vi.fn(
      async () =>
        buildResponse({
          status: 200,
          headers: {
            "x-github-repository-commit-sha": "deadbeef",
            "content-length": String(200 * 1024 * 1024), // 200 MB
          },
          body: streamOfChunks([new Uint8Array([0])]),
        }),
    );
    const provider = new GitHubProvider(
      fakeFetch as unknown as typeof fetch,
    );
    await expect(provider.fetchTarball(makeLink(), TEST_PAT)).rejects.toThrow(
      /REPO_TARBALL_TOO_LARGE/,
    );
    expect(s3Sends).toHaveLength(0);
  });
});
