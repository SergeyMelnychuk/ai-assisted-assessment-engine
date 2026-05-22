/**
 * Provider abstraction for repository ingest (Phase 3 Week 6, ADR-0010).
 *
 * The MVP ships GitHub only; GitLab / Bitbucket are post-roadmap. The
 * interface is intentionally narrow — one method, one name — because
 * the `ingest-repository` worker shouldn't know how each provider
 * authenticates or paginates. It hands the link in, gets a streamed
 * tarball back.
 *
 * Streaming is mandatory. We refuse to buffer the whole tarball into
 * memory; the provider implementation pipes chunks from the HTTP
 * response straight into MinIO so the archive-ingest worker can read
 * it back the same way.
 */

import type { RepositoryLink } from "@prisma/client";

export interface FetchedTarball {
  /** S3 key where the tarball now lives under `repo-archives/…`. */
  s3Key: string;
  /** Remote commit SHA this tarball captures (from headers or API). */
  sha: string;
  /** Size of the tarball on disk, for audit / ops visibility. */
  byteLength: number;
}

/**
 * Every provider speaks the same verb: "give me the current tarball".
 * Re-syncs call it again — for MVP we always pull the full archive
 * (ADR-0010 accepts the no-incremental-fetch cost). The link provides
 * identity (assessment, url, credentials), the provider provides HTTP.
 */
export interface RepoProvider {
  readonly name: "github";
  /**
   * `pat` is optional: when supplied the provider uses it; otherwise
   * it falls back to the legacy in-row encrypted columns. New
   * call-sites (post-Slice 3 PAT consolidation) always pass it from
   * the engagement-scoped AgentCredential vault.
   */
  fetchTarball(link: RepositoryLink, pat?: string): Promise<FetchedTarball>;
}

/**
 * Parse `owner/repo` (optionally `@ref`) out of a GitHub URL. Accepts
 * both `https://github.com/<o>/<r>` and the shorthand `<o>/<r>` paste.
 *
 * Kept free of the provider class so unit tests don't need to mock a
 * credential key just to exercise URL parsing.
 */
export function parseGithubRepoUrl(url: string): {
  owner: string;
  repo: string;
  ref: string;
} {
  // Strip hash fragments (`#section-anchor`) and query strings
  // (`?tab=readme`) the user may have copy-pasted from the GitHub web
  // UI — they never carry meaning for the tarball API and previously
  // caused the regex below to reject otherwise-valid URLs.
  const trimmed = url
    .trim()
    .replace(/[#?].*$/, "")
    .replace(/\.git$/, "");
  // https?://github.com/<owner>/<repo>(/tree/<ref>)?
  const webMatch = trimmed.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\/tree\/([^/]+))?\/?$/,
  );
  if (webMatch) {
    return {
      owner: webMatch[1],
      repo: webMatch[2],
      ref: webMatch[3] ?? "HEAD",
    };
  }
  const shorthand = trimmed.match(/^([^/\s]+)\/([^/\s@]+)(?:@(.+))?$/);
  if (shorthand) {
    return {
      owner: shorthand[1],
      repo: shorthand[2],
      ref: shorthand[3] ?? "HEAD",
    };
  }
  throw new Error(`Not a recognisable GitHub URL: ${url}`);
}
