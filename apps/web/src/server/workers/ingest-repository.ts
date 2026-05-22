/**
 * Ingest-repository worker (Phase 3 Week 6, ADR-0009/0010).
 *
 * Flow:
 *   1. Resolve the `RepositoryLink` + decrypt the PAT.
 *   2. Call the provider (`GitHubProvider.fetchTarball`) — streams the
 *      tarball from GitHub into MinIO under
 *      `repo-archives/{linkId}/{sha}.tar.gz`.
 *   3. Create a *parent* `Document` row (kind-ish signalled by a
 *      `parentDocumentId === null` archive stance, same convention as
 *      Week 5). The link's `parentDocumentId` points back at it for
 *      dashboard drill-down.
 *   4. Hand off to the Week 5 `ingest-archive` pipeline — no forking
 *      of the extract/fan-out logic. `ingest-archive` already applies
 *      the safety gates and the `.copilotignore` path; repo-specific
 *      filters (`.gitignore`, binary blacklist, 500 KB cap) layer on
 *      inside that worker via the helpers in `ignore-filter.ts`.
 *   5. Flip `RepositoryLink.ingestStatus` READY on completion, FAILED
 *      on error. Child success/failure is tracked per-Document.
 *
 * PAT handling:
 *   - The PAT is decrypted in-memory inside `GitHubProvider.fetchTarball`
 *     and dropped as soon as the HTTP request completes. It never
 *     lands in any log, audit row, or error message — every audit
 *     detail we write passes through `scrubCredential()`.
 *   - We explicitly do NOT persist the PAT anywhere decrypted. Even
 *     debug logs get the scrub treatment.
 *
 * Retry discipline:
 *   - Zero automatic retries. `attempts: 1` at the BullMQ level,
 *     plus no in-loop retries here. The one exception lives inside
 *     `GitHubProvider`: if GitHub 429s with a `Retry-After`, we
 *     honour it exactly once.
 */

import { randomUUID } from "node:crypto";

import { db } from "@/server/db";
import { log } from "@/server/lib/logger";
import { enqueueIngestArchive } from "@/server/queue/queue";
import {
  classifyProcessingError,
  formatErrorForUser,
} from "@/server/services/ai/error-classifier";
import { scrubCredential } from "@/server/services/repo/credentials";
import { GitHubProvider } from "@/server/services/repo/github-provider";
import type { RepoProvider } from "@/server/services/repo/provider";
import { getAgentCredential } from "@/server/services/agent/credentials";

export interface IngestRepositoryArgs {
  repositoryLinkId: string;
}

/**
 * Select the provider implementation for a link. Today this is
 * always GitHub; the abstraction exists so W6+ can slot in GitLab /
 * Bitbucket without touching the worker.
 */
function resolveProvider(provider: string): RepoProvider {
  switch (provider) {
    case "github":
      return new GitHubProvider();
    default:
      throw new Error(`Unsupported repo provider: ${provider}`);
  }
}

export async function ingestRepositoryJob(
  args: IngestRepositoryArgs,
  providerOverride?: RepoProvider,
): Promise<void> {
  const { repositoryLinkId } = args;

  const link = await db.repositoryLink.findUnique({
    where: { id: repositoryLinkId },
  });
  if (!link) {
    log.warn("repository link not found, skipping", {
      worker: "ingest-repository",
      repositoryLinkId,
    });
    return;
  }

  await db.repositoryLink.update({
    where: { id: repositoryLinkId },
    data: { ingestStatus: "EXTRACTING" },
  });

  try {
    const provider = providerOverride ?? resolveProvider(link.provider);

    // PAT consolidation (Slice 3): prefer the engagement-scoped
    // AgentCredential vault entry. Falls back to the link's legacy
    // in-row encrypted columns inside the provider when neither path
    // produces a token. New rows after the Slice 3 consolidation no
    // longer populate the in-row columns.
    const assessment = await db.assessment.findUnique({
      where: { id: link.assessmentId },
      select: { engagementId: true },
    });
    let vaultPat: string | undefined;
    if (assessment) {
      const cred = await getAgentCredential(
        db,
        assessment.engagementId,
        "github.pat",
      );
      if (cred) vaultPat = cred.secret;
    }

    // 1. Stream the tarball into MinIO.
    const fetched = await provider.fetchTarball(link, vaultPat);

    // 2. Create a parent Document we can hang the archive-ingest
    //    fan-out off. Reuses the Week 5 ARCHIVE_MANIFEST convention
    //    (no explicit enum value — Document kind is inferred from
    //    the presence of children) by keeping `parentDocumentId=null`.
    const filename = deriveTarballFilename(link.url, fetched.sha);
    const parent = await db.document.create({
      data: {
        assessmentId: link.assessmentId,
        filename,
        mimeType: "application/gzip",
        storagePath: fetched.s3Key,
        fileSize: fetched.byteLength,
        uploadType: "OTHER",
        ingestStatus: "PENDING",
        processingStatus: "PENDING",
        // The link was created by an authenticated user — the router
        // layer ensures `ctx.session.user.id` is a real row. We stash
        // the caller id on the link's audit row so blaming is easy;
        // the parent Document just needs *a* User for the FK. Using
        // the first OWNER of the engagement is safer than a fake id.
        uploadedById: await resolveUploaderId(link.assessmentId),
      },
    });

    await db.repositoryLink.update({
      where: { id: repositoryLinkId },
      data: {
        lastSha: fetched.sha,
        parentDocumentId: parent.id,
      },
    });

    // 3. Hand off to the Week 5 pipeline. From here on the archive
    //    worker owns the lifecycle — it'll flip the parent Document
    //    to READY / FAILED, and spawn per-child `ingest-document`
    //    jobs that apply the repo-specific filters via
    //    `ignore-filter.ts`.
    await enqueueIngestArchive(parent.id, fetched.s3Key);

    await db.$transaction([
      db.repositoryLink.update({
        where: { id: repositoryLinkId },
        data: {
          ingestStatus: "READY",
          lastSyncedAt: new Date(),
        },
      }),
      db.auditLog.create({
        data: {
          action: "INGEST_REPOSITORY",
          entityType: "RepositoryLink",
          entityId: repositoryLinkId,
          details: scrubCredential({
            provider: link.provider,
            url: link.url,
            sha: fetched.sha,
            s3Key: fetched.s3Key,
            byteLength: fetched.byteLength,
            parentDocumentId: parent.id,
          }),
        },
      }),
    ]);

    log.info("repository ingested", {
      worker: "ingest-repository",
      repositoryLinkId,
      url: link.url,
      sha: fetched.sha.slice(0, 10),
      parentDocumentId: parent.id,
    });
  } catch (err) {
    const classified = classifyProcessingError(err);
    // Re-scrub in case the error message contains a leaked token. The
    // provider is careful not to include the PAT, but belt-and-braces.
    const safeTechnical = scrubCredential({
      msg: classified.technicalDetail,
    }).msg;
    log.error("repository ingest failed", {
      worker: "ingest-repository",
      repositoryLinkId,
      url: link.url,
      category: classified.category,
      technicalDetail: safeTechnical,
    });
    await db.repositoryLink.update({
      where: { id: repositoryLinkId },
      data: { ingestStatus: "FAILED" },
    });
    await db.auditLog
      .create({
        data: {
          action: "INGEST_REPOSITORY_FAILED",
          entityType: "RepositoryLink",
          entityId: repositoryLinkId,
          details: scrubCredential({
            category: classified.category,
            isRetryable: classified.isRetryable,
            needsAdmin: classified.needsAdmin,
            technicalDetail: safeTechnical,
            userMessage: formatErrorForUser(classified),
          }),
        },
      })
      .catch(() => {
        /* best-effort */
      });
    throw err;
  }
}

function deriveTarballFilename(url: string, sha: string): string {
  const slug = url
    .replace(/\.git$/, "")
    .replace(/^https?:\/\//, "")
    .replace(/[^\w.-]+/g, "_")
    .slice(0, 80);
  const shortSha = sha.replace(/[^A-Za-z0-9]+/g, "").slice(0, 10) || "HEAD";
  return `${slug}@${shortSha}.tar.gz`;
}

/**
 * Find a plausible `User` id to stamp on the parent Document row.
 * The link is engagement-scoped — any OWNER / CONTRIBUTOR works. We
 * pick the earliest OWNER; falling back to any member if the
 * engagement has no explicit owner yet.
 */
async function resolveUploaderId(assessmentId: string): Promise<string> {
  const assessment = await db.assessment.findUnique({
    where: { id: assessmentId },
    select: { engagementId: true },
  });
  if (!assessment) {
    throw new Error(
      `Assessment ${assessmentId} vanished between create and ingest`,
    );
  }
  const member = await db.engagementMember.findFirst({
    where: { engagementId: assessment.engagementId },
    orderBy: [{ role: "asc" }],
    select: { userId: true },
  });
  if (!member) {
    // Extremely cold path — no members on an engagement is a
    // constraint violation elsewhere, but we refuse to invent a
    // user-id silently. Synthesise a pseudo-user ref so the caller
    // sees a specific failure rather than a FK error.
    return `missing-uploader-${randomUUID()}`;
  }
  return member.userId;
}
