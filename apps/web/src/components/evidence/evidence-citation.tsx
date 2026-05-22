"use client";

import type { ReactElement, ReactNode } from "react";
import { Github, Gitlab, GitBranch } from "lucide-react";
import type { RouterOutputs } from "@/lib/trpc";

/**
 * ADR-0028 — Single citation surface for an Evidence chunk.
 *
 * Renders consistently across:
 *   - Evidence Explorer search results
 *   - "Why this finding?" trail panel
 *   - Finding / risk / recommendation evidence lists
 *   - Agent trace viewer side panel
 *
 * Variants by trail shape:
 *   - Repo chunk:    {provider-icon} owner/repo · src/path.ts · ts · @abc1234
 *   - Document:      📄 architecture.md · §Security & IAM · p.12 · chunk 14/47
 *   - Archive child: 🗂 q3-handover.zip › docs/runbook.md · §Rollback
 *   - Bare path:     📁 src/auth/middleware.ts
 *   - Unknown:       (source unavailable)
 *
 * Repo chunks pick a provider icon (GitHub / GitLab / fallback)
 * derived from the `repoUrl` host. Server-side, repo archives have
 * their `repoUrl` / `commitSha` reconstructed from the parent
 * tarball filename so they always land in the repo branch rather
 * than rendering as opaque archive children.
 *
 * `interactive` enables click-through (filename → download, repo →
 * provider blob URL). Off by default so read-only contexts (DOCX
 * export preview, agent side panel) render cleanly without
 * affordances.
 */

type EvidenceTrail =
  RouterOutputs["evidenceExplorer"]["findingTrail"]["cited"][number]["trail"];

export interface EvidenceCitationProps {
  trail: EvidenceTrail;
  /** Cosine similarity (0..1) from the retriever, when known. */
  similarity?: number;
  /** Hybrid retrieval signal: which side ranked this chunk (ADR-0027). */
  denseRank?: number | null;
  lexicalRank?: number | null;
  /** Render the link affordances. Off → text-only display. */
  interactive?: boolean;
  className?: string;
}

export function EvidenceCitation({
  trail,
  similarity,
  denseRank,
  lexicalRank,
  interactive,
  className,
}: EvidenceCitationProps): ReactElement {
  const shape = pickShape(trail);
  return (
    <span
      className={
        "inline-flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground " +
        (className ?? "")
      }
    >
      <ShapeIcon shape={shape} />
      <CitationBody
        shape={shape}
        trail={trail}
        interactive={!!interactive}
      />
      {typeof similarity === "number" ? (
        <Chip title="Cosine similarity">
          sim {similarity.toFixed(2)}
        </Chip>
      ) : null}
      <MatchedOnChip dense={denseRank} lexical={lexicalRank} />
    </span>
  );
}

// ─── Display shape selection ───────────────────────────────────────

type RepoProvider = "github" | "gitlab" | "azure" | "bitbucket" | "other";

type Shape =
  | { kind: "repo"; provider: RepoProvider }
  | { kind: "archive" }
  | { kind: "document" }
  | { kind: "barePath" }
  | { kind: "unknown" };

function pickShape(trail: EvidenceTrail): Shape {
  if (trail.repoUrl)
    return { kind: "repo", provider: detectProvider(trail.repoUrl) };
  if (trail.parentDocumentId) return { kind: "archive" };
  if (trail.documentName) return { kind: "document" };
  if (trail.path) return { kind: "barePath" };
  return { kind: "unknown" };
}

function detectProvider(repoUrl: string): RepoProvider {
  if (/github\.com/i.test(repoUrl)) return "github";
  if (/gitlab\./i.test(repoUrl)) return "gitlab";
  if (/dev\.azure\.com|visualstudio\.com/i.test(repoUrl)) return "azure";
  if (/bitbucket\.org/i.test(repoUrl)) return "bitbucket";
  return "other";
}

function ShapeIcon({ shape }: { shape: Shape }): ReactNode {
  if (shape.kind === "repo") {
    // Lucide ships GitHub + GitLab; Azure DevOps and Bitbucket fall
    // back to a generic `GitBranch` rather than a wrong-brand icon.
    if (shape.provider === "github") {
      return (
        <Github
          className="size-3.5 text-foreground"
          aria-label="GitHub repository"
        />
      );
    }
    if (shape.provider === "gitlab") {
      return (
        <Gitlab
          className="size-3.5 text-foreground"
          aria-label="GitLab repository"
        />
      );
    }
    return (
      <GitBranch
        className="size-3.5 text-foreground"
        aria-label={`${shape.provider} repository`}
      />
    );
  }
  // Non-repo shapes keep the emoji glyphs — they read cleanly inline
  // and don't need provider differentiation.
  const glyph =
    shape.kind === "archive"
      ? "🗂"
      : shape.kind === "document"
        ? "📄"
        : shape.kind === "barePath"
          ? "📁"
          : "·";
  return <span aria-hidden>{glyph}</span>;
}

function CitationBody({
  shape,
  trail,
  interactive,
}: {
  shape: Shape;
  trail: EvidenceTrail;
  interactive: boolean;
}) {
  if (shape.kind === "unknown") return <span>source unavailable</span>;

  if (shape.kind === "repo") {
    const slug = repoSlug(trail.repoUrl ?? "");
    const blobUrl = buildRepoBlobUrl(trail);
    // Combine repo slug + file path into one anchor so the citation
    // reads as "this file in this repo" rather than two separate
    // labels. Truncate the middle of the combined label when it
    // overflows so the filename stays visible at the tail; the
    // anchor's `title` shows the actual URL we'd open on click.
    const display = compactRepoLabel(slug, trail.path ?? null);
    const tooltip =
      blobUrl ??
      (trail.repoUrl
        ? trail.repoUrl.replace(/\.git$/, "") +
          (trail.path ? `/${trail.path}` : "")
        : slug);
    return (
      <>
        {interactive && blobUrl ? (
          <a
            href={blobUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={tooltip}
            className="font-medium text-foreground underline decoration-dotted decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground"
          >
            {display}
          </a>
        ) : (
          <span title={tooltip} className="font-medium text-foreground">
            {display}
          </span>
        )}
        {trail.language ? (
          <>
            <Sep />
            <span>{trail.language}</span>
          </>
        ) : null}
        {isGitCommitSha(trail.commitSha) ? (
          <>
            <Sep />
            <span title={`Commit ${trail.commitSha}`}>
              @{trail.commitSha.slice(0, 7)}
            </span>
          </>
        ) : null}
      </>
    );
  }

  if (shape.kind === "archive") {
    return (
      <>
        <span className="font-medium text-foreground">
          {trail.parentDocumentName ?? "(archive)"}
        </span>
        <span>›</span>
        <span className="font-mono text-foreground">
          {trail.path ?? trail.documentName ?? "(member)"}
        </span>
        {trail.heading ? (
          <>
            <Sep />
            <span>§{trail.heading}</span>
          </>
        ) : null}
        <ChunkPosition trail={trail} />
      </>
    );
  }

  if (shape.kind === "document") {
    const filename = trail.documentName!;
    return (
      <>
        {interactive && trail.documentId ? (
          <a
            href={`/api/documents/${trail.documentId}/download`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-foreground underline decoration-dotted decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground"
          >
            {filename}
          </a>
        ) : (
          <span className="font-medium text-foreground">{filename}</span>
        )}
        {trail.heading ? (
          <>
            <Sep />
            <span>§{trail.heading}</span>
          </>
        ) : null}
        {trail.page != null ? (
          <>
            <Sep />
            <span>p.{trail.page}</span>
          </>
        ) : null}
        <ChunkPosition trail={trail} />
      </>
    );
  }

  // barePath
  return <span className="font-mono text-foreground">{trail.path}</span>;
}

// ─── Small sub-components ──────────────────────────────────────────

function Sep() {
  return <span className="opacity-60">·</span>;
}

function ChunkPosition({ trail }: { trail: EvidenceTrail }) {
  if (trail.chunkIndex == null) return null;
  const total =
    trail.chunkCount != null && trail.chunkCount > 0
      ? `/${trail.chunkCount}`
      : "";
  return (
    <>
      <Sep />
      <span title="Position within the source document">
        chunk {trail.chunkIndex + 1}
        {total}
      </span>
    </>
  );
}

function MatchedOnChip({
  dense,
  lexical,
}: {
  dense: number | null | undefined;
  lexical: number | null | undefined;
}) {
  // Both null/undefined means we don't have hybrid info — render
  // nothing. Don't tell the user about a feature they didn't enable.
  if (dense == null && lexical == null) return null;
  const tag =
    dense != null && lexical != null
      ? "semantic+lexical"
      : dense != null
        ? "semantic"
        : "lexical";
  return (
    <Chip title="Which retrieval side surfaced this chunk (ADR-0027)">
      matched: {tag}
    </Chip>
  );
}

function Chip({
  children,
  title,
}: {
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
    >
      {children}
    </span>
  );
}

// ─── Repo display helpers ─────────────────────────────────────────

/**
 * Strip a repo URL down to its display slug. Drops protocol,
 * hostname (the provider icon already conveys it), the `.git`
 * suffix, and the noisy `_git/` segment Azure DevOps URLs carry.
 *
 *   https://github.com/acme/infra        → "acme/infra"
 *   https://gitlab.com/g/sub/proj        → "g/sub/proj"
 *   https://dev.azure.com/org/proj/_git/repo
 *                                        → "org/proj/repo"
 */
function repoSlug(repoUrl: string): string {
  return repoUrl
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "")
    .replace(/^[^/]+\//, "")
    .replace(/\/_git\//, "/");
}

const REPO_LABEL_MAX = 56;

/**
 * Build the visible repo+path label that the citation renders as a
 * single link. Filename is preserved in full (always at the tail);
 * the slug is middle-truncated with `…` when the combined string
 * would otherwise blow up the row. Caller supplies the untruncated
 * URL via `title` for hover.
 */
function compactRepoLabel(slug: string, path: string | null): string {
  const combined = path ? `${slug}/${path}` : slug;
  if (combined.length <= REPO_LABEL_MAX) return combined;
  if (!path) return middleEllipsis(slug, REPO_LABEL_MAX);
  const tail = `/${path}`;
  const room = REPO_LABEL_MAX - tail.length;
  if (room < 8) {
    // Pathological case — the filename alone is long. Fall back to
    // a whole-string middle ellipsis so we still show *something*.
    return middleEllipsis(combined, REPO_LABEL_MAX);
  }
  return middleEllipsis(slug, room) + tail;
}

/**
 * True iff `s` is a 40-char hex SHA-1 — the only shape that builds
 * a working `blob/<ref>` URL across providers, and the only shape
 * that's safe to display as a short git commit hash. SHA-256
 * ETags (64 chars) and short SHAs from tarball filenames don't
 * qualify; for those we hide the `@<sha>` chip and fall back to
 * `HEAD` in the URL.
 */
function isGitCommitSha(s: string | null | undefined): s is string {
  return !!s && /^[0-9a-f]{40}$/i.test(s);
}

function middleEllipsis(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.max(1, Math.floor((max - 1) / 2));
  return s.slice(0, half) + "…" + s.slice(s.length - (max - half - 1));
}

// ─── Repo URL → blob URL ───────────────────────────────────────────

function buildRepoBlobUrl(trail: EvidenceTrail): string | null {
  if (!trail.repoUrl || !trail.path) return null;
  const base = trail.repoUrl.replace(/\.git$/, "").replace(/\/$/, "");
  // Reject non-commit values (short SHAs, 64-char SHA-256 ETags) and
  // fall back to `HEAD` so the link lands on the default branch.
  const ref = isGitCommitSha(trail.commitSha) ? trail.commitSha : "HEAD";
  if (/github\.com/.test(base)) {
    return `${base}/blob/${ref}/${trail.path}`;
  }
  if (/gitlab\./.test(base)) {
    return `${base}/-/blob/${ref}/${trail.path}`;
  }
  if (/bitbucket\.org/.test(base)) {
    return `${base}/src/${ref}/${trail.path}`;
  }
  if (/dev\.azure\.com|visualstudio\.com/.test(base)) {
    // Azure DevOps web client uses a path + version query, not a
    // path-segment URL like GitHub.
    return `${base}?path=/${encodeURI(trail.path)}&version=GC${ref}`;
  }
  // Fallback — bare repo URL, no deep file link.
  return base;
}
