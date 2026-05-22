/**
 * File filtering for `ingest-repository` (Phase 3 Week 6).
 *
 * We layer three filters, in order:
 *   1. `.gitignore` at archive root (if present). Minimal glob
 *      semantics — no nested gitignores, no negation, no Git's full
 *      pattern rules. The common 95% case: `node_modules/`,
 *      `dist/`, `*.log`, `*.pyc`.
 *   2. Hard-coded binary / generated blacklist (node_modules, target,
 *      dist, build, *.lock, *.min.js, *.pyc, *.so, *.class, *.jar,
 *      *.exe, vendor/). These are refused even if the repo's
 *      `.gitignore` doesn't mention them — a repo that checks in its
 *      build artefacts shouldn't pollute the evidence corpus.
 *   3. A hard file-size cap (500 KB). Large vendored dumps (generated
 *      client SDKs, pre-compiled assets) add noise without signal.
 *
 * All three are pure functions. No new deps — writing a tiny
 * gitignore parser is cheaper than pulling in `ignore` (15kb) for the
 * six patterns repositories actually care about.
 *
 * The repo-linking pipeline calls this *after* `ingest-archive`'s
 * safety gates have already passed (the tarball isn't a zip bomb);
 * we apply these extra filters before enqueueing a per-file
 * `ingest-document` so we don't embed boilerplate.
 */

export const REPO_FILE_SIZE_LIMIT_BYTES = 500 * 1024;

export const REPO_BINARY_BLACKLIST_SEGMENTS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "target",
  "dist",
  "build",
  "out",
  "vendor",
  ".next",
  ".cache",
  "__pycache__",
]);

export const REPO_BINARY_BLACKLIST_SUFFIXES: readonly string[] = [
  ".lock",
  ".min.js",
  ".min.css",
  ".pyc",
  ".so",
  ".class",
  ".jar",
  ".exe",
  ".dll",
  ".dylib",
  ".o",
  ".a",
  ".wasm",
];

export type SkipReason =
  | "size"
  | "blacklist"
  | "gitignore"
  | "empty";

export interface FilterDecision {
  keep: boolean;
  reason?: SkipReason;
}

export interface GitignorePattern {
  /** Raw pattern string minus leading `/` and negation markers. */
  pattern: string;
  /** Pattern originally referenced a directory (ended with `/`). */
  dirOnly: boolean;
  /** Pattern was anchored to the repo root (began with `/`). */
  anchored: boolean;
}

/**
 * Parse a `.gitignore` payload into structured patterns. We drop
 * blank lines, comments, and — for MVP simplicity — negation rules
 * (`!foo.txt`). A file caught by a blacklist above can't be un-
 * blacklisted by a gitignore negation; this keeps the precedence
 * order predictable.
 */
export function parseGitignore(raw: string): readonly GitignorePattern[] {
  const out: GitignorePattern[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("!")) continue; // negation unsupported
    const dirOnly = trimmed.endsWith("/");
    const stripped = dirOnly ? trimmed.slice(0, -1) : trimmed;
    const anchored = stripped.startsWith("/");
    out.push({
      pattern: anchored ? stripped.slice(1) : stripped,
      dirOnly,
      anchored,
    });
  }
  return out;
}

/**
 * Decide if a relative path matches a single gitignore pattern. The
 * matching is intentionally minimal:
 *   - `*` matches any sequence of non-slash chars.
 *   - `**` matches any sequence including slashes.
 *   - Anchored patterns only match from the root.
 *   - Non-anchored patterns match anywhere in the path.
 *   - Directory-only patterns match `foo/` style prefixes.
 *
 * Good enough for `node_modules/`, `*.log`, `dist/`, `src/generated/`
 * and the handful of other patterns that show up in real repo
 * gitignores. Nested gitignores in subdirectories are not supported.
 */
export function matchesGitignore(
  path: string,
  pat: GitignorePattern,
): boolean {
  const normalised = path.replace(/^\/+/, "").replace(/\\/g, "/");
  const regex = gitignoreToRegex(pat);
  if (pat.dirOnly) {
    // Match on the directory-prefix form of the path: any path
    // whose segment-start equals the pattern qualifies.
    const segments = normalised.split("/");
    for (let i = 1; i <= segments.length; i += 1) {
      const sub = segments.slice(0, i).join("/");
      if (regex.test(sub)) return true;
      if (!pat.anchored && regex.test(segments[i - 1] ?? "")) {
        return true;
      }
    }
    return false;
  }
  return regex.test(normalised);
}

function gitignoreToRegex(pat: GitignorePattern): RegExp {
  // Escape regex specials we don't use, then restore the two glob
  // operators we do support.
  const escaped = pat.pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000") // placeholder for **
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, "[^/]");

  if (pat.anchored) {
    return new RegExp(`^${escaped}$`);
  }
  // Unanchored: allow match on the basename *or* any path segment.
  return new RegExp(`(^|/)${escaped}$`);
}

/**
 * Top-level filter. Returns `{keep:false, reason}` with a machine-
 * readable reason so the audit log can count skips per reason.
 */
export function shouldIngestRepoFile(opts: {
  path: string;
  size: number;
  gitignore?: readonly GitignorePattern[];
}): FilterDecision {
  const { path, size, gitignore = [] } = opts;
  if (size === 0) return { keep: false, reason: "empty" };
  if (size > REPO_FILE_SIZE_LIMIT_BYTES) {
    return { keep: false, reason: "size" };
  }

  const normalised = path.replace(/^\/+/, "").replace(/\\/g, "/");
  const segments = normalised.split("/").filter(Boolean);
  const basename = segments[segments.length - 1] ?? "";

  // Blacklist — segment-level.
  for (const seg of segments) {
    if (REPO_BINARY_BLACKLIST_SEGMENTS.has(seg)) {
      return { keep: false, reason: "blacklist" };
    }
  }
  // Blacklist — suffix on basename.
  for (const suffix of REPO_BINARY_BLACKLIST_SUFFIXES) {
    if (basename.endsWith(suffix)) {
      return { keep: false, reason: "blacklist" };
    }
  }

  // Gitignore.
  for (const pat of gitignore) {
    if (matchesGitignore(normalised, pat)) {
      return { keep: false, reason: "gitignore" };
    }
  }

  return { keep: true };
}
