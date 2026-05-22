/**
 * Language tagging for code files pulled from a linked repository
 * (Phase 3 Week 6).
 *
 * We stash the language string into `Evidence.chunkSource.language` so
 * retrieval-time filters can route "show me Go files about auth" at
 * zero extra cost. JSONB already, no schema change — the analyser and
 * retriever just need to know the key exists.
 *
 * Extension-based is deliberate. File-content sniffing (shebang,
 * magic-bytes, `tree-sitter`) is the post-roadmap polish item called
 * out in the roadmap. The common case is unambiguous — `.go` is Go,
 * `.ts` is TypeScript — and the false-positive rate on extension-
 * based tagging is low enough to ship.
 */

const EXTENSION_TO_LANGUAGE: Readonly<Record<string, string>> = {
  // ── general-purpose ───────────────────────────────────────────
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  py: "python",
  pyi: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  clj: "clojure",
  lua: "lua",
  hs: "haskell",
  dart: "dart",

  // ── shell / ops ───────────────────────────────────────────────
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ps1: "powershell",
  tf: "terraform",
  tfvars: "terraform",
  dockerfile: "docker",

  // ── data / config / IaC ───────────────────────────────────────
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  xml: "xml",
  sql: "sql",
  graphql: "graphql",
  proto: "protobuf",

  // ── prose / docs ─────────────────────────────────────────────
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  rst: "restructuredtext",
  txt: "text",
  adoc: "asciidoc",

  // ── web ──────────────────────────────────────────────────────
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
};

/**
 * Best-effort language tag for a file path. Returns `null` when we
 * genuinely don't know — callers must handle null rather than us
 * returning "unknown" as a string (which would pollute retrieval
 * filters with a false-signal tag).
 *
 * Special-case handling for files without extensions:
 *   - `Dockerfile`, `Containerfile` → docker
 *   - `Makefile`, `GNUmakefile` → make
 */
export function detectLanguage(path: string): string | null {
  const basename = path.split("/").pop() ?? path;
  const lowerBase = basename.toLowerCase();
  if (lowerBase === "dockerfile" || lowerBase === "containerfile") {
    return "docker";
  }
  if (lowerBase === "makefile" || lowerBase === "gnumakefile") {
    return "make";
  }
  const dotIdx = basename.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx === basename.length - 1) return null;
  const ext = basename.slice(dotIdx + 1).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}

// Exported for unit tests that want to spot-check the full set.
export const LANGUAGE_EXTENSIONS = EXTENSION_TO_LANGUAGE;
