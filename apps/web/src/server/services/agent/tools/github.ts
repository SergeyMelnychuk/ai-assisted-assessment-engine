/**
 * GitHub adapter tools — ADR-0014 §4.
 *
 * v1 ships **read-only** GitHub access via the REST API:
 *
 *   - `github.read_file`     — fetch the contents of a single path on a
 *                              ref (defaults to the repo's default
 *                              branch). Emits one Evidence row per call.
 *   - `github.list_repo_files` — list the entries at a directory path.
 *                              Emits no evidence (it's a structural
 *                              query); the agent uses the result to
 *                              decide which files to read next.
 *
 * Both tools declare `requiresCredentials: ["github.pat"]`. The harness
 * pre-resolves the PAT from the engagement-scoped vault before
 * dispatch; if no row exists (or the row is expired/revoked) the
 * harness opens an `AgentCredentialRequest` and the run pauses
 * `AWAITING_USER` until the modal is fulfilled. The PAT itself never
 * touches `argsJson` or `resultJson` — only the `Authorization` header
 * on the outbound HTTPS request.
 *
 * **Why fetch and not Octokit?** The two endpoints we need are trivial,
 * and adding `@octokit/rest` to the bundle for two GETs is a poor
 * trade. If/when `github.search_code` or PR-aware tools land we'll
 * switch — Octokit's pagination + retry are worth real money there.
 *
 * **Fine-grained PATs.** The credential-scope spec recommends
 * `Contents: Read` + `Metadata: Read` on selected repos. The error
 * mapping below distinguishes 401 (token invalid/expired) from 403
 * (token valid but missing permission for *this* repo) — those are
 * different user-fixable states and the modal copy diverges.
 */

import { z } from "zod";
import { defineTool, type Tool } from "../tool";
import type { EvidenceDraft, ToolContext } from "../types";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "assessment-copilot-agent/1.0";

// ─── Input schemas ──────────────────────────────────────────────────

// `owner/repo` mirrors what the planner sees in the tool catalog — short
// strings the model has no trouble producing. Reasonable max lengths
// keep a malformed plan from sending megabytes of garbage.
const repoLocator = z.object({
  owner: z.string().trim().min(1).max(80),
  repo: z.string().trim().min(1).max(120),
  ref: z.string().trim().min(1).max(255).optional(),
});

const readFileInput = repoLocator.extend({
  path: z.string().trim().min(1).max(1024),
  /**
   * Domain tag the emitted Evidence row carries. Must be one of the
   * assessment's `activeDomains`; the harness re-validates against the
   * assessment row before dispatch (a tool-level guard would have to
   * re-fetch the assessment, which is wasteful).
   */
  domain: z.string().min(1).max(64),
});
export type GithubReadFileInput = z.infer<typeof readFileInput>;

const listFilesInput = repoLocator.extend({
  /** Directory path; omit or pass "" to list the repo root. */
  path: z.string().trim().max(1024).optional(),
});
export type GithubListFilesInput = z.infer<typeof listFilesInput>;

// ─── Result shapes ──────────────────────────────────────────────────

interface GithubReadFileOutput {
  path: string;
  ref: string;
  size: number;
  content: string;
  sha: string;
  htmlUrl: string;
}

interface GithubListFilesOutput {
  ref: string;
  entries: ReadonlyArray<{
    path: string;
    type: "file" | "dir" | "submodule" | "symlink";
    size: number | null;
    sha: string;
  }>;
}

// ─── Wire structures (subset of the GitHub REST shapes we care about) ─

interface GithubContentItemFile {
  type: "file";
  name: string;
  path: string;
  size: number;
  sha: string;
  encoding: string;
  content: string;
  html_url: string;
}

interface GithubContentItemDir {
  type: "dir" | "submodule" | "symlink";
  name: string;
  path: string;
  size: number | null;
  sha: string;
  html_url: string;
}

type GithubContentResponse = GithubContentItemFile | GithubContentItemDir[];

// ─── Helpers ────────────────────────────────────────────────────────

function authHeaders(pat: string): HeadersInit {
  // Bearer scheme works for both classic and fine-grained PATs; GitHub
  // recommends `Bearer` over the legacy `token` prefix.
  return {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
}

/**
 * Map a non-2xx GitHub response to a stable `errorClass` string. The
 * planner uses these classes to decide whether to retry with a
 * different path/ref, ask for a different PAT, or stop.
 */
function classifyHttpError(status: number): {
  errorClass: string;
  message: string;
} {
  switch (status) {
    case 401:
      return {
        errorClass: "github.unauthorized",
        message:
          "GitHub rejected the token (401). It may be expired or revoked. " +
          "Provide a fresh fine-grained PAT.",
      };
    case 403:
      return {
        errorClass: "github.forbidden",
        message:
          "GitHub returned 403. The token is valid but lacks permission " +
          "for this repo, or the rate limit is exhausted. Confirm the " +
          "fine-grained PAT lists this repo and grants Contents: Read.",
      };
    case 404:
      return {
        errorClass: "github.not_found",
        message:
          "GitHub returned 404 — the repo, ref, or path does not exist " +
          "(or the token can't see it).",
      };
    case 409:
      return {
        errorClass: "github.conflict",
        message: "GitHub returned 409 — likely an empty repo with no default branch.",
      };
    case 422:
      return {
        errorClass: "github.invalid_request",
        message: "GitHub returned 422 — invalid path or ref.",
      };
    default:
      if (status >= 500) {
        return {
          errorClass: "github.server_error",
          message: `GitHub returned ${status} — upstream server error.`,
        };
      }
      return {
        errorClass: "github.unexpected",
        message: `Unexpected GitHub response: ${status}.`,
      };
  }
}

async function githubGet(
  ctx: ToolContext,
  pat: string,
  path: string,
): Promise<{ ok: true; body: GithubContentResponse } | { ok: false; status: number }> {
  const url = `${GITHUB_API}${path}`;
  ctx.logger.debug("github.fetch", { url });
  const res = await fetch(url, {
    method: "GET",
    headers: authHeaders(pat),
    signal: ctx.abortSignal,
  });
  if (!res.ok) {
    return { ok: false, status: res.status };
  }
  const body = (await res.json()) as GithubContentResponse;
  return { ok: true, body };
}

// ─── Tool: github.read_file ─────────────────────────────────────────

export const githubReadFile: Tool<GithubReadFileInput, GithubReadFileOutput> =
  defineTool<GithubReadFileInput, GithubReadFileOutput>({
    name: "github.read_file",
    description:
      "Read a file from a GitHub repository. Returns the decoded text " +
      "and emits one Evidence row tagged with the supplied domain. " +
      "Read-only; uses the engagement's GitHub PAT.",
    inputSchema: readFileInput,
    scope: "network",
    async execute(ctx, args) {
      const pat = ctx.credentials["github.pat"];
      if (!pat) {
        // Defensive: the harness should have pre-resolved before
        // dispatch. If we reach here the credential bag was assembled
        // wrong — fail loudly rather than silently fall through.
        return {
          ok: false,
          errorClass: "agent.missing_credential",
          message: "github.pat not in credential bag at dispatch time",
        };
      }
      const ref = args.ref ?? null;
      const refQuery = ref ? `?ref=${encodeURIComponent(ref)}` : "";
      const apiPath = `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(
        args.repo,
      )}/contents/${args.path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}${refQuery}`;

      const r = await githubGet(ctx, pat, apiPath);
      if (!r.ok) {
        return { ok: false, ...classifyHttpError(r.status) };
      }
      const body = r.body;
      if (Array.isArray(body) || body.type !== "file") {
        return {
          ok: false,
          errorClass: "github.not_a_file",
          message: `Path ${args.path} is a directory; use github.list_repo_files.`,
        };
      }
      const text = decodeContent(body);
      const data: GithubReadFileOutput = {
        path: body.path,
        ref: ref ?? "HEAD",
        size: body.size,
        content: text,
        sha: body.sha,
        htmlUrl: body.html_url,
      };
      const evidence: EvidenceDraft[] = [
        {
          domain: args.domain,
          content: text,
          confidence: 0.6,
          provenance: {
            kind: "repo",
            ref: {
              owner: args.owner,
              repo: args.repo,
              ref: data.ref,
              path: body.path,
              sha: body.sha,
              htmlUrl: body.html_url,
            },
          },
          contentSha: body.sha,
        },
      ];
      return { ok: true, data, evidence };
    },
  });

// ─── Tool: github.list_repo_files ───────────────────────────────────

export const githubListFiles: Tool<GithubListFilesInput, GithubListFilesOutput> =
  defineTool<GithubListFilesInput, GithubListFilesOutput>({
    name: "github.list_repo_files",
    description:
      "List entries in a directory of a GitHub repository. Use this to " +
      "discover paths before calling github.read_file. Returns no Evidence.",
    inputSchema: listFilesInput,
    scope: "network",
    async execute(ctx, args) {
      const pat = ctx.credentials["github.pat"];
      if (!pat) {
        return {
          ok: false,
          errorClass: "agent.missing_credential",
          message: "github.pat not in credential bag at dispatch time",
        };
      }
      const ref = args.ref ?? null;
      const refQuery = ref ? `?ref=${encodeURIComponent(ref)}` : "";
      const dirPath = args.path ?? "";
      const apiPath = `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(
        args.repo,
      )}/contents/${
        dirPath ? dirPath.split("/").map(encodeURIComponent).join("/") : ""
      }${refQuery}`;

      const r = await githubGet(ctx, pat, apiPath);
      if (!r.ok) {
        return { ok: false, ...classifyHttpError(r.status) };
      }
      const body = r.body;
      const items = Array.isArray(body) ? body : [body];
      const entries = items.map((it) => ({
        path: it.path,
        type: it.type,
        size: "size" in it ? (it.size ?? null) : null,
        sha: it.sha,
      }));
      return {
        ok: true,
        data: { ref: ref ?? "HEAD", entries },
      };
    },
  });

/** Tools' declared credential needs — keyed off `tool.name` for the
 *  harness's pre-resolution pass. (We attach this off the tool object
 *  rather than as a property on `Tool` so the existing minimal `Tool`
 *  contract stays unchanged; the harness imports this map.) */
export const GITHUB_TOOL_CREDENTIALS: Record<string, readonly string[]> = {
  [githubReadFile.name]: ["github.pat"],
  [githubListFiles.name]: ["github.pat"],
};

function decodeContent(item: GithubContentItemFile): string {
  if (item.encoding === "base64") {
    return Buffer.from(item.content.replace(/\n/g, ""), "base64").toString("utf8");
  }
  // GitHub also returns `"none"` for files larger than 1MB — for v1
  // we surface that as a clear failure rather than silently truncating.
  if (item.encoding === "none") {
    throw new Error(
      "GitHub returned the file metadata without contents (file too large for the contents API).",
    );
  }
  return item.content;
}
