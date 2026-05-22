import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";
import { createRouter, protectedProcedure } from "../trpc";
import {
  assertAssessmentAccess,
  engagementAccessFilter,
} from "@/server/authz";
import { retrieve } from "@/server/services/rag-retriever";
import { embedTexts } from "@/server/services/ai/embedding-service";
import {
  clusterChunks,
  DEFAULT_DUPLICATE_COSINE,
  type ClusteredChunk,
  type RankedChunk,
} from "@/server/services/evidence-clusterer";

/**
 * Evidence Explorer router (Phase 3 Week 7, ADR-0011).
 *
 * Three endpoints, all membership-scoped via `assertAssessmentAccess`
 * or the parent-assessment engagement filter:
 *
 *   - `search`        — semantic search over an assessment's evidence,
 *                       returns clustered chunks (near-duplicates merged).
 *   - `trail`         — hydrates a list of evidence ids with the source
 *                       trail the UI renders ("from <doc> §<heading>").
 *   - `findingTrail`  — resolves both the model-cited chunks and the
 *                       full retriever-given set for a single finding.
 *
 * Type contract: everything here is strictly typed end-to-end. No `any`.
 */

// Evidence ids in this codebase come in two shapes:
//   - `ev_<uuid-v4>` — written by the ingest worker
//     (`ingest-document.ts`); dominant in production data.
//   - Plain `cuid()` — Prisma's `@default(cuid())` falls through for
//     rows created via the standard ORM path (agent evidence
//     emitter, older ingest paths).
// `z.string().cuid()` only matches the second one, which broke any
// procedure that took an evidence id as input. Accept either shape.
const evidenceIdSchema = z
  .string()
  .regex(
    /^(c[a-z0-9]{20,}|ev_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    "Invalid evidence id",
  );

// ─── Shapes ──────────────────────────────────────────────────────

export interface EvidenceTrailSourceTrail {
  /** Document filename, if the evidence originated from a Document. */
  documentName: string | null;
  /**
   * Document id for the download link (ADR-0028). Drives the
   * filename → `/api/documents/<id>/download` deep link in the
   * `EvidenceCitation` component.
   */
  documentId: string | null;
  /** Heading text captured at chunk time (from `chunkSource.heading`). */
  heading: string | null;
  /** Page number, if the chunker recorded one. */
  page: number | null;
  /** 0-based chunk index within the source document. ADR-0028. */
  chunkIndex: number | null;
  /** Total chunk count on the source document. ADR-0028. */
  chunkCount: number | null;
  /** Language tag (set by the repo-link ingest path for code chunks). */
  language: string | null;
  /** Repo URL if the chunk came from a linked repository (W6+). */
  repoUrl: string | null;
  /** Git commit SHA the repo file was read at, when ingested via repo-link. */
  commitSha: string | null;
  /** Path within the repo / archive, when available. */
  path: string | null;
  /** Archive parent document id, for chunks fanned out from a zip / tar. */
  parentDocumentId: string | null;
  /** Archive parent filename, e.g. `q3-handover.zip`. */
  parentDocumentName: string | null;
}

export interface EvidenceWithTrail {
  evidenceId: string;
  content: string;
  domain: string;
  sourceType: string;
  confidence: number;
  chunkIndex: number | null;
  trail: EvidenceTrailSourceTrail;
}

export interface ClusteredChunkDTO {
  representativeId: string;
  memberIds: string[];
  duplicateCount: number;
  sources: string[];
  content: string;
  similarity: number;
  trail: EvidenceTrailSourceTrail;
  /**
   * Hybrid-retrieval ranks for the representative chunk (ADR-0027).
   * Null when the cosine-only path produced the result, so the
   * `matched: …` chip stays hidden for non-hybrid runs.
   */
  denseRank: number | null;
  lexicalRank: number | null;
}

// ─── Router ──────────────────────────────────────────────────────

export const evidenceExplorerRouter = createRouter({
  /**
   * Semantic search. Embeds the caller's free-text query, retrieves the
   * top-K chunks from the assessment corpus (optionally domain-scoped),
   * then clusters near-duplicates so the UI doesn't surface three
   * copies of the same paragraph as three rows.
   */
  search: protectedProcedure
    .input(
      z.object({
        assessmentId: z.string().cuid(),
        query: z.string().min(1).max(500),
        domain: z.string().min(1).max(120).optional(),
        // Multi-select: empty / undefined means "all documents".
        // Capped at 50 to keep the IN-list bounded; any reasonable
        // assessment-scope filter fits well under this.
        documentIds: z.array(z.string().cuid()).max(50).optional(),
        topK: z.number().int().min(1).max(100).optional(),
      }),
    )
    .query(async ({ ctx, input }): Promise<ClusteredChunkDTO[]> => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);

      const retrieved = await retrieve(ctx.db, {
        assessmentId: input.assessmentId,
        query: input.query,
        domain: input.domain,
        documentIds: input.documentIds,
        topK: input.topK ?? 20,
      });
      if (retrieved.length === 0) return [];

      // Hydrate embeddings for the retrieved ids so the clusterer can
      // compute pair-wise cosine. The retriever itself doesn't return
      // vectors (the `<=>` SQL computes distance server-side); we pull
      // them back here as a one-off — this is the only call site that
      // needs the raw vectors in JS.
      const embeddingRows = await ctx.db.$queryRaw<
        Array<{ id: string; embedding: number[] | null }>
      >`SELECT id, embedding::float4[] AS embedding
        FROM evidences
        WHERE id = ANY(${retrieved.map((c) => c.evidenceId)}::text[])`;
      const embByCid = new Map<string, number[]>();
      for (const r of embeddingRows) {
        if (r.embedding) embByCid.set(r.id, r.embedding);
      }

      const ranked: RankedChunk[] = retrieved
        .map((c) => ({
          evidenceId: c.evidenceId,
          content: c.content,
          similarity: c.similarity,
          embedding: embByCid.get(c.evidenceId) ?? [],
          source: c.sourceDocumentId ?? undefined,
          denseRank: c.denseRank ?? null,
          lexicalRank: c.lexicalRank ?? null,
        }))
        // Drop any row whose embedding we couldn't hydrate (backfill
        // gap) — better to show a singleton than merge with a zero-
        // vector and collapse everything together.
        .filter((c) => c.embedding.length > 0);

      const clusters = clusterChunks(ranked, {
        threshold: DEFAULT_DUPLICATE_COSINE,
      });
      return hydrateClusterTrails(ctx.db, clusters);
    }),

  /**
   * Hydrate a list of evidence ids with their full source trail for
   * reviewer UI. Returns items in the same order as the input, with
   * unknown / out-of-scope ids silently dropped (never throws —
   * reviewer surfaces tolerate a partially resolved list).
   */
  trail: protectedProcedure
    .input(
      z.object({
        assessmentId: z.string().cuid(),
        evidenceIds: z.array(evidenceIdSchema).max(200),
      }),
    )
    .query(async ({ ctx, input }): Promise<EvidenceWithTrail[]> => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      if (input.evidenceIds.length === 0) return [];
      return resolveTrails(ctx.db, input.assessmentId, input.evidenceIds);
    }),

  /**
   * Context window around a chunk (ADR-0028). Used by the chunk-
   * preview popup so reviewers can read the paragraphs *before* and
   * *after* the retrieved chunk before deciding whether it really
   * supports the finding.
   *
   * Returns the chunk itself plus up to `before` / `after` adjacent
   * chunks from the same source document, ordered by `chunkIndex`.
   * For chunks without a document (`Answer`-derived evidence or
   * orphaned rows), returns just the target — the caller renders
   * what's available.
   */
  contextWindow: protectedProcedure
    .input(
      z.object({
        evidenceId: evidenceIdSchema,
        before: z.number().int().min(0).max(10).optional(),
        after: z.number().int().min(0).max(10).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const before = input.before ?? 2;
      const after = input.after ?? 2;
      const target = await ctx.db.evidence.findFirst({
        where: {
          id: input.evidenceId,
          assessment: { engagement: engagementAccessFilter(ctx.session) },
        },
        select: {
          id: true,
          assessmentId: true,
          documentId: true,
          chunkIndex: true,
          chunkSource: true,
          content: true,
          document: {
            select: {
              id: true,
              filename: true,
              chunkCount: true,
              parentDocumentId: true,
              parentDocument: {
            select: {
              id: true,
              filename: true,
              repositoryLinks: { select: { lastSha: true }, take: 1 },
            },
          },
            },
          },
        },
      });
      if (!target) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Evidence chunk not found",
        });
      }
      const trail = extractTrail(
        target.document?.filename ?? null,
        target.chunkSource,
        {
          documentId: target.document?.id ?? null,
          chunkIndex: target.chunkIndex,
          chunkCount: target.document?.chunkCount ?? null,
          parentDocumentId: target.document?.parentDocument?.id ?? null,
          parentDocumentName: target.document?.parentDocument?.filename ?? null,
          parentRepoFullSha:
            target.document?.parentDocument?.repositoryLinks?.[0]?.lastSha ??
            null,
        },
      );

      // No document or no chunk position — there are no neighbours to
      // fetch. Return just the target so the dialog has something to
      // render (e.g. answer-derived chunks).
      if (target.documentId === null || target.chunkIndex === null) {
        return {
          trail,
          neighbours: [
            {
              evidenceId: target.id,
              chunkIndex: target.chunkIndex,
              content: target.content,
              isTarget: true,
            },
          ],
        };
      }

      const lo = target.chunkIndex - before;
      const hi = target.chunkIndex + after;
      const siblings = await ctx.db.evidence.findMany({
        where: {
          documentId: target.documentId,
          chunkIndex: { gte: lo, lte: hi },
        },
        select: {
          id: true,
          chunkIndex: true,
          content: true,
        },
        orderBy: { chunkIndex: "asc" },
      });
      const neighbours = siblings.map((s) => ({
        evidenceId: s.id,
        chunkIndex: s.chunkIndex,
        content: s.content,
        isTarget: s.id === target.id,
      }));
      return { trail, neighbours };
    }),

  /**
   * The "Why this finding?" endpoint. Returns both the model-cited set
   * (`evidenceIds`) and the full retriever-given set
   * (`retrievedEvidenceIds`). The reviewer sees both, understands what
   * the AI had vs. what it chose to surface.
   */
  findingTrail: protectedProcedure
    .input(z.object({ findingId: z.string().cuid() }))
    .query(
      async ({
        ctx,
        input,
      }): Promise<{ cited: EvidenceWithTrail[]; retrieved: EvidenceWithTrail[] }> => {
        const finding = await ctx.db.finding.findFirst({
          where: {
            id: input.findingId,
            assessment: { engagement: engagementAccessFilter(ctx.session) },
          },
          select: {
            assessmentId: true,
            evidenceIds: true,
            retrievedEvidenceIds: true,
          },
        });
        if (!finding) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Finding not found",
          });
        }
        const citedIds = finding.evidenceIds;
        // Dedupe "retrieved but cited" so the UI's secondary list only
        // shows *extra* context, not what's already in the cited list.
        const citedSet = new Set(citedIds);
        const retrievedOnlyIds = finding.retrievedEvidenceIds.filter(
          (id) => !citedSet.has(id),
        );
        const [cited, retrieved] = await Promise.all([
          resolveTrails(ctx.db, finding.assessmentId, citedIds),
          resolveTrails(ctx.db, finding.assessmentId, retrievedOnlyIds),
        ]);
        return { cited, retrieved };
      },
    ),

  /**
   * Domains for the Evidence Explorer dropdown.
   *
   * Returns the assessment's `activeDomains` (design-time set), each
   * annotated with two counts:
   *   - `taggedCount` — chunks explicitly stamped with this domain at
   *     ingest or analysis time.
   *   - `catchAllCount` — chunks in the `"ingested"` bucket. The
   *     chunker writes everything to that bucket by default; the
   *     analysis engine treats it as available to every domain
   *     (`e.domain === domain || e.domain === "ingested"`). The
   *     Explorer's domain filter mirrors that semantic, so picking a
   *     domain means "tagged + catch-all".
   *
   * The `"ingested"` bucket itself is never returned as its own row
   * — it's an implementation detail, not a user-facing domain.
   */
  listDomains: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      const [assessment, counts] = await Promise.all([
        ctx.db.assessment.findUnique({
          where: { id: input.assessmentId },
          select: { activeDomains: true },
        }),
        ctx.db.$queryRaw<Array<{ domain: string; count: bigint }>>`
          SELECT domain, COUNT(*)::bigint AS count
          FROM evidences
          WHERE assessment_id = ${input.assessmentId}
            AND domain IS NOT NULL
          GROUP BY domain
        `,
      ]);
      const countByDomain = new Map(
        counts.map((r) => [r.domain, Number(r.count)]),
      );
      const catchAllCount = countByDomain.get("ingested") ?? 0;
      const active = assessment?.activeDomains ?? [];
      // Surface any domain that has its own tagged chunks but isn't
      // on the active list (e.g. older analysis runs that wrote into
      // a domain Setup later removed). Excludes the catch-all bucket
      // itself.
      const extra = counts
        .map((r) => r.domain)
        .filter((d) => d !== "ingested" && !active.includes(d));
      const ordered = [...active, ...extra];
      return {
        catchAllCount,
        domains: ordered.map((domain) => ({
          domain,
          taggedCount: countByDomain.get(domain) ?? 0,
        })),
      };
    }),

  /**
   * Manually re-tag a set of evidence rows (Option C). Lets the
   * reviewer fix mis-classified or untagged chunks after ingest.
   *
   * Authz: assessment-level access. We don't separately gate on
   * OWNER/ADMIN — anyone with read access already drives the
   * analysis pipeline that consumes these tags.
   *
   * `domain` is a free-form string but expected to be an
   * `activeDomains` value or the catch-all `"ingested"`. The
   * retriever / dropdown only ever match exact strings, so an
   * unknown value would silently exclude itself from results —
   * surfaced through the UI's domain dropdown to keep typos rare.
   */
  retag: protectedProcedure
    .input(
      z.object({
        assessmentId: z.string().cuid(),
        evidenceIds: z.array(evidenceIdSchema).min(1).max(500),
        domain: z.string().min(1).max(120),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      const result = await ctx.db.evidence.updateMany({
        where: {
          id: { in: input.evidenceIds },
          // Defence-in-depth: only allow updating rows that belong
          // to the asserted assessment. Prevents a forged id from a
          // sibling assessment from being silently retagged.
          assessmentId: input.assessmentId,
        },
        data: { domain: input.domain },
      });
      await ctx.db.auditLog.create({
        data: {
          userId: ctx.session.user.id,
          action: "EVIDENCE_RETAGGED",
          entityType: "Assessment",
          entityId: input.assessmentId,
          details: {
            count: result.count,
            requested: input.evidenceIds.length,
            domain: input.domain,
          },
        },
      });
      return { ok: true, updated: result.count };
    }),

  /**
   * Documents in this assessment, with chunk counts. Drives the
   * Evidence Explorer's "Browse documents" tab and the
   * source-document filter dropdown.
   *
   * Excludes archive parents whose only purpose is to group child
   * documents — they have no chunks of their own and would render
   * as empty rows. The standard `Document.parentDocumentId` join
   * surfaces children; the parent itself is filtered out by the
   * `chunkCount > 0` requirement at the caller.
   */
  listDocuments: protectedProcedure
    .input(z.object({ assessmentId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await assertAssessmentAccess(ctx.db, ctx.session, input.assessmentId);
      const docs = await ctx.db.document.findMany({
        where: { assessmentId: input.assessmentId },
        select: {
          id: true,
          filename: true,
          mimeType: true,
          fileSize: true,
          uploadType: true,
          ingestStatus: true,
          parentDocumentId: true,
          createdAt: true,
          _count: { select: { evidences: true } },
        },
        orderBy: [{ createdAt: "desc" }],
      });
      return docs.map((d) => ({
        id: d.id,
        filename: d.filename,
        mimeType: d.mimeType,
        fileSize: d.fileSize,
        uploadType: d.uploadType,
        ingestStatus: d.ingestStatus,
        isArchiveChild: d.parentDocumentId !== null,
        chunkCount: d._count.evidences,
        createdAt: d.createdAt,
      }));
    }),
});

// ─── Hydration helpers ──────────────────────────────────────────

/**
 * Load Evidence rows + their parent Documents + (when present) the
 * repository link that sourced them, and build the source-trail for
 * each. The queries are intentionally narrow — we pull only what the
 * UI renders, never the embedding column (huge).
 */
async function resolveTrails(
  db: PrismaClient,
  assessmentId: string,
  evidenceIds: string[],
): Promise<EvidenceWithTrail[]> {
  if (evidenceIds.length === 0) return [];
  const rows = await db.evidence.findMany({
    where: { id: { in: evidenceIds }, assessmentId },
    select: {
      id: true,
      content: true,
      domain: true,
      sourceType: true,
      confidence: true,
      chunkIndex: true,
      chunkSource: true,
      document: {
        select: {
          id: true,
          filename: true,
          chunkCount: true,
          parentDocumentId: true,
          parentDocument: {
            select: {
              id: true,
              filename: true,
              repositoryLinks: { select: { lastSha: true }, take: 1 },
            },
          },
        },
      },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const out: EvidenceWithTrail[] = [];
  for (const id of evidenceIds) {
    const r = byId.get(id);
    if (!r) continue;
    out.push({
      evidenceId: r.id,
      content: r.content,
      domain: r.domain,
      sourceType: r.sourceType,
      confidence: r.confidence,
      chunkIndex: r.chunkIndex,
      trail: extractTrail(r.document?.filename ?? null, r.chunkSource, {
        documentId: r.document?.id ?? null,
        chunkIndex: r.chunkIndex,
        chunkCount: r.document?.chunkCount ?? null,
        parentDocumentId: r.document?.parentDocument?.id ?? null,
        parentDocumentName: r.document?.parentDocument?.filename ?? null,
        parentRepoFullSha:
          r.document?.parentDocument?.repositoryLinks?.[0]?.lastSha ?? null,
      }),
    });
  }
  return out;
}

async function hydrateClusterTrails(
  db: PrismaClient,
  clusters: ClusteredChunk[],
): Promise<ClusteredChunkDTO[]> {
  if (clusters.length === 0) return [];
  const repIds = clusters.map((c) => c.representativeId);
  const rows = await db.evidence.findMany({
    where: { id: { in: repIds } },
    select: {
      id: true,
      chunkIndex: true,
      chunkSource: true,
      document: {
        select: {
          id: true,
          filename: true,
          chunkCount: true,
          parentDocumentId: true,
          parentDocument: {
            select: {
              id: true,
              filename: true,
              repositoryLinks: { select: { lastSha: true }, take: 1 },
            },
          },
        },
      },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  return clusters.map((c) => {
    const r = byId.get(c.representativeId);
    return {
      representativeId: c.representativeId,
      memberIds: c.memberIds,
      duplicateCount: c.duplicateCount,
      sources: c.sources,
      content: c.representative.content,
      similarity: c.representative.similarity,
      denseRank: c.representative.denseRank ?? null,
      lexicalRank: c.representative.lexicalRank ?? null,
      trail: extractTrail(
        r?.document?.filename ?? null,
        r?.chunkSource ?? null,
        {
          documentId: r?.document?.id ?? null,
          chunkIndex: r?.chunkIndex ?? null,
          chunkCount: r?.document?.chunkCount ?? null,
          parentDocumentId: r?.document?.parentDocument?.id ?? null,
          parentDocumentName: r?.document?.parentDocument?.filename ?? null,
          parentRepoFullSha:
            r?.document?.parentDocument?.repositoryLinks?.[0]?.lastSha ?? null,
        },
      ),
    };
  });
}

/**
 * Pull the known fields out of the `chunkSource` JSON without trusting
 * the shape (the column is `Json?`, so defensive extraction is the only
 * safe path). Repo-link metadata (W6+) lands under `language` / `path`
 * / `repoUrl` keys when that ingest path populates them.
 *
 * For repo archives (chunks whose parent Document is a tarball
 * produced by `deriveTarballFilename` in `workers/ingest-repository.ts`),
 * the per-chunk `chunkSource` doesn't carry `repoUrl` / `commitSha` —
 * those live on the parent Document only. We reconstruct them from
 * the parent filename here so the citation can render the chunk as
 * a repo file (with provider icon) instead of a generic archive.
 */
function extractTrail(
  documentName: string | null,
  chunkSource: unknown,
  extras: {
    documentId?: string | null;
    chunkIndex?: number | null;
    chunkCount?: number | null;
    parentDocumentId?: string | null;
    parentDocumentName?: string | null;
    /**
     * Full commit SHA from the parent RepositoryLink (when this
     * chunk belongs to a repo-archive tarball). Used as the
     * authoritative ref in the citation's blob URL — the short
     * SHA in the tarball filename isn't a valid GitHub ref.
     */
    parentRepoFullSha?: string | null;
  } = {},
): EvidenceTrailSourceTrail {
  const src = (chunkSource ?? {}) as Record<string, unknown>;
  const srcPath =
    typeof src.path === "string"
      ? src.path
      : typeof src.sourcePath === "string"
        ? src.sourcePath
        : null;
  // Per-chunk repo metadata if the ingest path populated it.
  let repoUrl = typeof src.repoUrl === "string" ? src.repoUrl : null;
  let commitSha = typeof src.commitSha === "string" ? src.commitSha : null;
  let path = srcPath;
  let parentDocumentId = extras.parentDocumentId ?? null;
  let parentDocumentName = extras.parentDocumentName ?? null;

  // Repo archives: lift repo identity off the parent filename and
  // hide the archive wrapper so the chunk renders as a repo file.
  if (!repoUrl && parentDocumentName) {
    const parsed = parseRepoArchiveFilename(parentDocumentName);
    if (parsed) {
      repoUrl = parsed.repoUrl;
      // Only the full SHA from RepositoryLink builds a working
      // blob URL — the tarball filename's 10-char SHA isn't a
      // valid GitHub ref ("Cannot find a valid ref"). When we
      // don't have the full SHA, leave `commitSha` null and let
      // the client fall back to `HEAD` (the default branch).
      commitSha = commitSha ?? extras.parentRepoFullSha ?? null;
      // Prefer the per-chunk source path; fall back to the child
      // document filename (the basename inside the archive).
      path = path ?? documentName;
      // Once we promote the chunk to a repo file, drop the archive
      // parent — the citation should read as `owner/repo · path`,
      // not as an archive child.
      parentDocumentId = null;
      parentDocumentName = null;
    }
  }

  return {
    documentName,
    documentId: extras.documentId ?? null,
    heading: typeof src.heading === "string" ? src.heading : null,
    page: typeof src.page === "number" ? src.page : null,
    chunkIndex: extras.chunkIndex ?? null,
    chunkCount: extras.chunkCount ?? null,
    language: typeof src.language === "string" ? src.language : null,
    repoUrl,
    commitSha,
    path,
    parentDocumentId,
    parentDocumentName,
  };
}

/**
 * Parse a repo-ingest tarball filename of the shape
 *   `<host>_<slugified-path>@<sha>.tar.gz`
 * (produced by `deriveTarballFilename` in the repo-ingest worker)
 * back into a repo URL + commit SHA + display slug.
 *
 * We can recover this from the filename alone because the ingest
 * worker encodes everything we need: hostname, owner/repo path,
 * and short SHA. Provider-specific shapes:
 *
 *   - GitHub:    `github.com_<owner>_<repo>@<sha>.tar.gz`
 *                  (owner can't contain `_`, so split on first `_`)
 *   - GitLab:    `gitlab.com_<group>_<…subgroups…>_<project>@<sha>.tar.gz`
 *                  (subgroups collapse — we reconstruct best-effort)
 *   - Azure:     `dev.azure.com_<org>_<project>__git_<repo>@<sha>.tar.gz`
 *                  (the `_git` segment is the marker)
 *   - Bitbucket: `bitbucket.org_<workspace>_<repo>@<sha>.tar.gz`
 *
 * Returns `null` for any filename that doesn't match the pattern —
 * non-repo archives (plain user-uploaded `.zip` / `.tar.gz`) fall
 * through and render as regular archive children.
 */
export function parseRepoArchiveFilename(
  filename: string,
): { repoUrl: string; commitSha: string; displaySlug: string } | null {
  const m = /^([a-z0-9.-]+)_(.+)@([a-z0-9]+)\.tar\.gz$/i.exec(filename);
  if (!m) return null;
  const [, host, rest, sha] = m;
  if (host === "github.com" || host === "bitbucket.org") {
    const sep = rest.indexOf("_");
    if (sep <= 0) return null;
    const owner = rest.slice(0, sep);
    const repo = rest.slice(sep + 1);
    return {
      repoUrl: `https://${host}/${owner}/${repo}`,
      commitSha: sha,
      displaySlug: `${owner}/${repo}`,
    };
  }
  if (host === "gitlab.com") {
    const sep = rest.indexOf("_");
    if (sep <= 0) return null;
    const group = rest.slice(0, sep);
    // GitLab subgroups: `_` between segments collapses path info.
    // Reconstruct as the best guess — the URL may not match for
    // deeply nested subgroups, but the display reads correctly.
    const project = rest.slice(sep + 1).replace(/_/g, "/");
    return {
      repoUrl: `https://gitlab.com/${group}/${project}`,
      commitSha: sha,
      displaySlug: `${group}/${project}`,
    };
  }
  if (host === "dev.azure.com") {
    const gitSplit = rest.split("__git_");
    if (gitSplit.length !== 2) return null;
    const [orgProject, repo] = gitSplit;
    const slashedOP = orgProject.replace(/_/g, "/");
    return {
      repoUrl: `https://dev.azure.com/${slashedOP}/_git/${repo}`,
      commitSha: sha,
      displaySlug: `${slashedOP}/${repo}`,
    };
  }
  return null;
}

// Re-export the embedding helper so the smoke tests / integration
// suites can mock one import path rather than reach into the embedding
// service directly.
export { embedTexts };
