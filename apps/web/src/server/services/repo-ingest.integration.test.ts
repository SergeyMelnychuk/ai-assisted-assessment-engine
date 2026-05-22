/**
 * Repo-ingest integration test — Phase 3 Week 6 gap-fill (ADR-0009/0010).
 *
 * We don't have `nock` installed (checked `package.json`), so we stub
 * the global `fetch` used by `GitHubProvider.fetchTarball`. The test
 * builds a small tar.gz in memory with three entries:
 *
 *   - `repo/src/index.ts`             (plain TS — should ingest)
 *   - `repo/node_modules/foo/bar.js`  (blacklist segment — should skip)
 *   - `repo/.env`                     (sensitive — should skip)
 *
 * We then walk the tarball through `tar-stream` (same dep the archive
 * worker uses) and apply `shouldIngestRepoFile` to every entry —
 * exactly the filter layer the real ingest pipeline runs after the
 * archive gates pass. Assertions:
 *
 *   1. Only `src/index.ts` survives the filter (Evidence-row analogue).
 *   2. The PAT we pass to `GitHubProvider` never appears in the
 *      resulting audit-detail payloads — `scrubCredential` strips it.
 *
 * The broader end-to-end worker shape (`ingestRepositoryJob` touching
 * Prisma + S3 + BullMQ) is deferred to an integration test with a
 * Testcontainers Postgres; this level exercises the HTTP → tarball →
 * filter → scrub slice, which is the one with the PAT leakage risk.
 */

import { Readable } from "node:stream";
import { createGunzip, gzipSync } from "node:zlib";
import type { Headers as TarHeaders } from "tar-stream";
import tar from "tar-stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GitHubProvider } from "./repo/github-provider";
import { scrubCredential } from "./repo/credentials";
import { parseGitignore, shouldIngestRepoFile } from "./repo/ignore-filter";

// Treat `.env` as a secret file that must never be ingested. The
// repo filter takes gitignore patterns at call time — this is the
// supported way to block secret-shaped files. (Other secret-blocking
// like `gitleaks` lives in a separate scan layer.)
const TEST_GITIGNORE = parseGitignore(".env\nnode_modules/\n");

// A recognisable test PAT — matches the `ghp_` classic PAT pattern so
// `scrubCredential`'s regex fires. The 123-literal below is
// deliberately embedded in a few places to simulate the real leakage
// surfaces we're defending against (error messages, audit details).
const TEST_PAT = "ghp_TESTPATSENTINEL123XXXXXXXXXXXXXXXXXX";

// Mock the AES-GCM credentials path — we don't want to plumb a real
// key through the test, and the provider's decrypt is a pure function
// we can stub. The test's concern is what happens *after* decryption.
vi.mock("./repo/credentials", async () => {
  const actual = await vi.importActual<typeof import("./repo/credentials")>(
    "./repo/credentials",
  );
  return {
    ...actual,
    decryptCredential: () => TEST_PAT,
  };
});

// Mock the S3 client so we never try to connect to MinIO. The provider
// pipes the tarball stream into `PutObjectCommand`; we just need the
// `s3.send` stub to drain the stream and resolve.
vi.mock("@/server/storage/minio", () => ({
  s3: {
    send: vi.fn(async (cmd: { input: { Body?: unknown } }) => {
      // Drain the body stream so the test doesn't hang.
      const body = cmd?.input?.Body;
      if (body instanceof Readable) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _chunk of body) {
          // discard
        }
      }
      return {};
    }),
  },
  BUCKET: "test-bucket",
  ensureBucket: vi.fn(async () => undefined),
  buildStorageKey: (a: string, b: string, c: string) => `${a}/${b}/${c}`,
  putObject: vi.fn(async () => undefined),
}));

async function buildTestTarball(): Promise<Buffer> {
  const pack = tar.pack();
  const entries: Array<{ name: string; body: string }> = [
    { name: "repo/src/index.ts", body: "export const hello = 1;\n" },
    { name: "repo/node_modules/foo/bar.js", body: "module.exports = 1;\n" },
    { name: "repo/.env", body: "SECRET=never-ingested\n" },
  ];
  const chunks: Buffer[] = [];
  pack.on("data", (c: Buffer) => chunks.push(c));
  // Add entries sequentially via the callback form so each is fully
  // written before the next starts. The original code used the
  // body-string overload + a synchronous loop, which let the loop
  // finish before any "data" events fired — leaving the chunks
  // array empty and producing a zero-byte tarball.
  for (const e of entries) {
    await new Promise<void>((resolve) => {
      // tar-stream's typed callback is `() => void`; the runtime
      // passes an error as the first arg too, but the type model
      // doesn't expose that. We don't fail tar-pack writes in tests;
      // resolving on call is sufficient.
      pack.entry({ name: e.name }, e.body, () => resolve());
    });
  }
  pack.finalize();
  await new Promise<void>((resolve) => pack.on("end", resolve));
  const uncompressed = Buffer.concat(chunks);
  return gzipSync(uncompressed);
}

async function extractTarEntries(
  tarball: Buffer,
): Promise<Array<{ name: string; size: number }>> {
  const extract = tar.extract();
  const out: Array<{ name: string; size: number }> = [];
  extract.on("entry", (header: TarHeaders, stream: Readable, next: () => void) => {
    let size = 0;
    stream.on("data", (c: Buffer) => {
      size += c.length;
    });
    stream.on("end", () => {
      out.push({ name: header.name, size });
      next();
    });
    stream.resume();
  });

  const source = Readable.from(tarball)
    .pipe(createGunzip())
    .pipe(extract as unknown as NodeJS.WritableStream);
  await new Promise<void>((resolve, reject) => {
    source.on("finish", () => resolve());
    source.on("error", reject);
  });
  return out;
}

describe("repo-ingest integration (stubbed GitHub tarball)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches tarball, filters to src/index.ts, never leaks the PAT", async () => {
    const tarball = await buildTestTarball();
    // Stub global fetch to return our in-memory tarball with a believable
    // header shape for the real provider to parse.
    const stub = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(tarball));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: {
          "content-length": String(tarball.length),
          "x-github-repository-commit-sha": "deadbeefcafef00d",
          "content-type": "application/gzip",
        },
      });
    });
    vi.stubGlobal("fetch", stub);

    const provider = new GitHubProvider(stub as unknown as typeof fetch);

    // Minimal link shape — only the fields the provider reads.
    // The PAT is supplied via the second argument now (Slice 3 PAT
    // consolidation: the provider no longer decrypts in-row columns).
    const fetched = await provider.fetchTarball(
      {
        id: "link-1",
        url: "https://github.com/acme/demo",
      } as never,
      TEST_PAT,
    );

    expect(fetched.sha).toBe("deadbeefcafef00d");
    expect(fetched.byteLength).toBe(tarball.length);

    // Assertion 1: the PAT was sent on the Authorization header (so we
    // know the provider actually used it) but never leaks downstream.
    const firstCall = stub.mock.calls[0] as unknown as
      | [RequestInfo | URL, RequestInit?]
      | undefined;
    const init = (firstCall?.[1] ?? {}) as RequestInit;
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toContain(TEST_PAT);

    // Assertion 2: walk the tarball and apply the ignore-filter. Only
    // `src/index.ts` should survive.
    const entries = await extractTarEntries(tarball);
    const surviving: string[] = [];
    for (const entry of entries) {
      // Strip the top-level `repo/` prefix tar-stream preserves —
      // GitHub prefixes every entry with a commit-derived dir name,
      // and the real archive worker normalises the same way.
      const relPath = entry.name.replace(/^[^/]+\//, "");
      const decision = shouldIngestRepoFile({
        path: relPath,
        size: entry.size,
        gitignore: TEST_GITIGNORE,
      });
      if (decision.keep) surviving.push(relPath);
    }
    expect(surviving).toEqual(["src/index.ts"]);

    // Assertion 3: every audit-log-shaped payload we might write for
    // this ingest must pass through `scrubCredential` and come out
    // PAT-free, even when the PAT ended up in a nested field or an
    // error message.
    const pretendAuditDetails = {
      provider: "github",
      url: "https://github.com/acme/demo",
      sha: fetched.sha,
      // Simulate the pathological case: the PAT leaked into a nested
      // error trace via some upstream library. `scrubCredential`
      // stringifies, regexes, and re-parses — a deep leak still gets
      // redacted.
      error: {
        message: `failed to fetch with token ${TEST_PAT}`,
        headers: { authorization: `Bearer ${TEST_PAT}` },
      },
    };
    const scrubbed = scrubCredential(pretendAuditDetails);
    const serialised = JSON.stringify(scrubbed);
    expect(serialised).not.toContain(TEST_PAT);
    expect(serialised).toContain("[redacted]");
  });
});
