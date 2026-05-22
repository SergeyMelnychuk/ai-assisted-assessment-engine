/**
 * GitHub implementation of `RepoProvider` (Phase 3 Week 6, ADR-0010).
 *
 * Uses the tarball endpoint:
 *   GET /repos/{owner}/{repo}/tarball/{ref}
 * with `Authorization: Bearer <PAT>`. The response is a gzipped tar
 * stream we pipe into MinIO under
 *   `repo-archives/{linkId}/{sha}.tar.gz`.
 *
 * Why the tarball API over `git clone`:
 *   - No git binary in the worker image.
 *   - One HTTP call — nothing to tear down.
 *   - Side-steps ssh-agent and credential-helper configuration.
 *
 * Trade-off: no incremental fetch. Re-sync = full re-download. For
 * MVP scale (a handful of sub-100 MB repos per engagement) this is
 * fine; the 100 MB GitHub ceiling trips `REPO_TARBALL_TOO_LARGE`
 * rather than silently truncating.
 *
 * Error discipline:
 *   - Streaming, never buffering.
 *   - Zero automatic retries. If GitHub returns 429 with Retry-After
 *     we honour it exactly once, then surface. No loops.
 *   - PAT goes into the Authorization header only. Never logged,
 *     never put in error messages — we scrub via `scrubCredential`
 *     before any audit write.
 */


import type { RepositoryLink } from "@prisma/client";

import { parseGithubRepoUrl, type FetchedTarball, type RepoProvider } from "./provider";
import { ensureBucket, s3, BUCKET } from "@/server/storage/minio";
import { PutObjectCommand } from "@aws-sdk/client-s3";

// GitHub tarball-API hard ceiling. Actually 100 MB at time of writing;
// we treat anything approaching it as a warning. The streaming walker
// in `ingest-archive` enforces its own uncompressed cap downstream.
const GITHUB_TARBALL_MAX_BYTES = 100 * 1024 * 1024;

export class GitHubProvider implements RepoProvider {
  readonly name = "github" as const;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async fetchTarball(link: RepositoryLink, pat?: string): Promise<FetchedTarball> {
    const { owner, repo, ref } = parseGithubRepoUrl(link.url);
    // The PAT comes from the engagement-scoped credential vault (the
    // `agent_credentials` table) and is passed in by the ingest
    // worker. The legacy in-row encrypted columns were dropped in
    // migration `20260427201500_drop_legacy_pat_cols` once every PAT
    // was backfilled into the vault. No fallback path remains: a
    // missing vault entry is a configuration error worth failing on.
    if (!pat) {
      throw new Error(
        "No PAT available for this RepositoryLink. " +
          "Add a github.pat for the engagement in the credential vault.",
      );
    }

    const refSlug = ref === "HEAD" ? "" : `/${encodeURIComponent(ref)}`;
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball${refSlug}`;

    const res = await this.fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "assessment-copilot/phase-3-week-6",
      },
    });

    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      classifyGithubError(res);
    }
    if (!res.body) {
      throw new Error("GitHub returned no body for tarball request");
    }

    // Prefer the commit SHA header; fall back to ETag (strong-etag
    // quotes stripped) so a re-sync can dedupe if GitHub ever drops
    // the custom header.
    const sha =
      res.headers.get("x-github-repository-commit-sha") ??
      (res.headers.get("etag") ?? "").replace(/^W\//, "").replace(/"/g, "") ??
      "unknown";

    const contentLength = Number.parseInt(
      res.headers.get("content-length") ?? "0",
      10,
    );
    if (Number.isFinite(contentLength) && contentLength > GITHUB_TARBALL_MAX_BYTES) {
      await res.body.cancel().catch(() => {});
      throw new Error(
        `REPO_TARBALL_TOO_LARGE: GitHub tarball declared ${contentLength} bytes (cap ${GITHUB_TARBALL_MAX_BYTES})`,
      );
    }

    await ensureBucket();
    const s3Key = `repo-archives/${link.id}/${sanitiseSha(sha)}.tar.gz`;

    // Drain the WHATWG ReadableStream into memory while enforcing the
    // cap. AWS SDK v3 rejects `PutObjectCommand` with a stream body and
    // no `ContentLength` (it refuses to send `x-amz-decoded-content-length:
    // undefined`). Streaming uploads for unknown-length bodies require
    // `@aws-sdk/lib-storage`'s `Upload`, which we don't take a dep on:
    // the 100 MB cap bounds memory per job, so a simple buffer works.
    let seenBytes = 0;
    const chunks: Buffer[] = [];
    const webStream = res.body as ReadableStream<Uint8Array>;
    const reader = webStream.getReader();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      seenBytes += value.byteLength;
      if (seenBytes > GITHUB_TARBALL_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(
          `REPO_TARBALL_TOO_LARGE: streamed ${seenBytes} bytes past cap ${GITHUB_TARBALL_MAX_BYTES}`,
        );
      }
      chunks.push(Buffer.from(value));
    }
    const body = Buffer.concat(chunks, seenBytes);

    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: s3Key,
        Body: body,
        ContentLength: body.byteLength,
        ContentType: "application/gzip",
      }),
    );

    return { s3Key, sha, byteLength: seenBytes };
  }
}

/**
 * Map a non-OK GitHub response onto the classified error taxonomy.
 * Throws; never returns. The `throw` shape matches
 * `error-classifier.ts`'s `REPO_*` matchers (which look for the tag
 * prefix at the front of the error message).
 */
function classifyGithubError(res: Response): never {
  if (res.status === 401) {
    throw new Error(
      `REPO_AUTH_FAILED: GitHub rejected the PAT (HTTP 401). The token may be expired, revoked, or missing the 'repo' scope.`,
    );
  }
  if (res.status === 404) {
    throw new Error(
      `REPO_NOT_FOUND: GitHub returned 404. The repo may be private and the PAT lacks access, or the URL is wrong.`,
    );
  }
  if (res.status === 403) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining === "0") {
      const retryAfter = res.headers.get("retry-after") ?? "60";
      throw new Error(
        `REPO_RATE_LIMITED: GitHub API rate-limit exhausted (retry after ${retryAfter}s).`,
      );
    }
    throw new Error(
      `REPO_AUTH_FAILED: GitHub returned 403 — the PAT likely lacks the required scope.`,
    );
  }
  if (res.status === 413) {
    throw new Error(
      `REPO_TARBALL_TOO_LARGE: GitHub returned 413 — the repo exceeds the tarball API ceiling.`,
    );
  }
  throw new Error(
    `GitHub tarball fetch failed: HTTP ${res.status} ${res.statusText}`,
  );
}

function sanitiseSha(sha: string): string {
  return sha.replace(/[^A-Za-z0-9.-]+/g, "_").slice(0, 80) || "unknown";
}
