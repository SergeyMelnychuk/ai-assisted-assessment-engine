import { describe, expect, it } from "vitest";
import {
  matchesGitignore,
  parseGitignore,
  REPO_FILE_SIZE_LIMIT_BYTES,
  shouldIngestRepoFile,
} from "./ignore-filter";

describe("parseGitignore", () => {
  it("parses patterns, dropping comments + blanks + negations", () => {
    const raw = `
      # this is a comment
      node_modules/
      *.log
      /dist
      !keepme.log
    `;
    const patterns = parseGitignore(raw);
    expect(patterns).toHaveLength(3);
    expect(patterns[0]).toEqual({
      pattern: "node_modules",
      dirOnly: true,
      anchored: false,
    });
    expect(patterns[1]).toEqual({
      pattern: "*.log",
      dirOnly: false,
      anchored: false,
    });
    expect(patterns[2]).toEqual({
      pattern: "dist",
      dirOnly: false,
      anchored: true,
    });
  });
});

describe("matchesGitignore", () => {
  const pats = parseGitignore("node_modules/\n*.log\n/dist\nsrc/generated/");
  const find = (name: string) =>
    pats.find((p) => p.pattern.includes(name.replace("/", "")));

  it("matches a directory pattern anywhere", () => {
    const pat = pats[0]; // node_modules/
    expect(matchesGitignore("node_modules/a/b", pat)).toBe(true);
    expect(matchesGitignore("packages/foo/node_modules/x", pat)).toBe(true);
    expect(matchesGitignore("src/app.ts", pat)).toBe(false);
  });

  it("matches a *.log suffix", () => {
    const pat = pats[1];
    expect(matchesGitignore("debug.log", pat)).toBe(true);
    expect(matchesGitignore("nested/path/trace.log", pat)).toBe(true);
    expect(matchesGitignore("logfile.txt", pat)).toBe(false);
  });

  it("respects anchored patterns", () => {
    const pat = pats[2]; // /dist
    expect(matchesGitignore("dist", pat)).toBe(true);
    expect(matchesGitignore("packages/foo/dist", pat)).toBe(false);
    // sanity: silence 'find' unused warning
    void find;
  });

  it("matches nested directory patterns", () => {
    const pat = pats[3]; // src/generated/
    expect(matchesGitignore("src/generated/client.ts", pat)).toBe(true);
    expect(matchesGitignore("src/other.ts", pat)).toBe(false);
  });
});

describe("shouldIngestRepoFile", () => {
  it("keeps a typical source file", () => {
    expect(
      shouldIngestRepoFile({ path: "src/auth.ts", size: 5_000 }),
    ).toEqual({ keep: true });
  });

  it("skips empty files", () => {
    expect(shouldIngestRepoFile({ path: "src/empty.ts", size: 0 })).toEqual({
      keep: false,
      reason: "empty",
    });
  });

  it("skips files over the size cap", () => {
    expect(
      shouldIngestRepoFile({
        path: "src/huge.sql",
        size: REPO_FILE_SIZE_LIMIT_BYTES + 1,
      }),
    ).toEqual({ keep: false, reason: "size" });
  });

  it.each([
    "node_modules/foo/index.js",
    "packages/a/node_modules/b/c.ts",
    "target/release/app",
    "dist/bundle.js",
    "build/output.js",
    "out/index.html",
    "vendor/rails/something.rb",
    ".next/cache/x",
  ])("skips blacklist segment: %s", (path) => {
    const d = shouldIngestRepoFile({ path, size: 1000 });
    expect(d.keep).toBe(false);
    expect(d.reason).toBe("blacklist");
  });

  it.each([
    "pnpm-lock.yaml.lock",
    "assets/app.min.js",
    "assets/app.min.css",
    "build/x.pyc",
    "native/lib.so",
    "jvm/MyClass.class",
    "bin/util.exe",
    "lib/hello.dll",
    "obj/file.o",
  ])("skips blacklist suffix: %s", (path) => {
    const d = shouldIngestRepoFile({ path, size: 1000 });
    expect(d.keep).toBe(false);
    expect(d.reason).toBe("blacklist");
  });

  it("skips files matched by gitignore patterns", () => {
    const gitignore = parseGitignore("*.log\ncoverage/");
    expect(
      shouldIngestRepoFile({
        path: "logs/debug.log",
        size: 100,
        gitignore,
      }),
    ).toEqual({ keep: false, reason: "gitignore" });
    expect(
      shouldIngestRepoFile({
        path: "coverage/lcov.info",
        size: 100,
        gitignore,
      }),
    ).toEqual({ keep: false, reason: "gitignore" });
  });

  it("prefers blacklist over gitignore (reason reported)", () => {
    const gitignore = parseGitignore("*.ts");
    const d = shouldIngestRepoFile({
      path: "node_modules/foo.ts",
      size: 100,
      gitignore,
    });
    expect(d.keep).toBe(false);
    expect(d.reason).toBe("blacklist");
  });
});
