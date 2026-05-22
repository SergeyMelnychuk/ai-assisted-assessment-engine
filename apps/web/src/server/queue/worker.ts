/**
 * Long-running worker process for the document-processing queue. Run via
 *   pnpm --filter @copilot/web worker
 * in a separate terminal from `pnpm dev`. The worker imports services
 * directly (Prisma, storage, Claude) so it doesn't need Next.js to be
 * running to process jobs.
 */
import { Worker, type Job } from "bullmq";
import {
  DOCUMENT_QUEUE_NAME,
  redisConnection,
  registerPruneLogsRepeatable,
  type DocumentJobData,
} from "./queue";
import { log } from "../lib/logger";
import { ingestDocumentJob } from "./jobs/ingest-document";
import { ingestDiagramJob } from "./jobs/ingest-diagram";
import { ingestArchiveJob } from "../workers/ingest-archive";
import { ingestRepositoryJob } from "../workers/ingest-repository";
import { generateFollowUpsJob } from "./jobs/generate-follow-ups";
import { runAnalysisJob } from "./jobs/run-analysis";
import { runEstimationJob } from "./jobs/run-estimation";
import { generateDeliverableJob } from "./jobs/generate-deliverable";
import { pruneLogsJob } from "./jobs/prune-logs";
import { agentHarnessJob } from "./jobs/agent-harness";
import { proposeTemplateBindingJob } from "./jobs/propose-template-binding";

const worker = new Worker<DocumentJobData>(
  DOCUMENT_QUEUE_NAME,
  async (job: Job<DocumentJobData>) => {
    const data = job.data;
    switch (data.type) {
      case "ingest-document":
        return ingestDocumentJob(data.documentId);
      case "ingest-diagram":
        return ingestDiagramJob(data.documentId);
      case "ingest-archive":
        return ingestArchiveJob({
          documentId: data.documentId,
          s3Key: data.s3Key,
        });
      case "ingest-repository":
        return ingestRepositoryJob({
          repositoryLinkId: data.repositoryLinkId,
        });
      case "generate-follow-ups":
        return generateFollowUpsJob(data.assessmentId);
      case "run-analysis":
        return runAnalysisJob(data.assessmentId, data.mode ?? "FAST");
      case "run-estimation":
        return runEstimationJob(data.assessmentId, data.templateId);
      case "generate-deliverable":
        return generateDeliverableJob(
          data.assessmentId,
          data.deliverableType,
          data.templateId,
        );
      case "prune-logs":
        return pruneLogsJob();
      case "agent-harness":
        return agentHarnessJob(data.runId);
      case "propose-template-binding":
        return proposeTemplateBindingJob(data.templateId);
      default: {
        // Exhaustiveness check — catches stale enqueues after a job-type
        // rename without silently dropping messages.
        const _exhaustive: never = data;
        throw new Error(`Unknown job data: ${JSON.stringify(_exhaustive)}`);
      }
    }
  },
  {
    connection: redisConnection,
    // Week 8 (ADR-0012): bumped from 3 → 5 now that we have per-call
    // cost instrumentation + the domain fan-out is concurrency-capped
    // internally. Ingest jobs are cheap; analysis jobs are the floor.
    // Drop back if Anthropic rate-limit errors start appearing in the
    // audit log.
    concurrency: 5,
    // BullMQ lock management. Defaults (30s lockDuration / 30s stalled
    // interval) were written for short jobs; our analysis job is
    // sequential across 8 domains with a 2s inter-call delay and per-
    // call Claude latency that can hit 30-60s on rich prompts. Result:
    // the lock used to expire mid-run, BullMQ flagged the job stalled,
    // and auto-retried — producing ghost reruns and cascading rate
    // limits. Raising lockDuration to 10 minutes covers the realistic
    // worst case (8 domains × ~60s + buffer). lockRenewTime auto-
    // defaults to half of lockDuration so the lock is refreshed every
    // ~5 minutes; stalledInterval stays snappy so a *truly* crashed
    // worker is still noticed within 30s of unlock.
    lockDuration: 10 * 60 * 1000,
    stalledInterval: 30_000,
    maxStalledCount: 1,
  },
);

worker.on("completed", (job) => {
  log.info("job completed", {
    worker: "queue",
    jobName: job.name,
    jobId: job.id,
  });
});

worker.on("failed", (job, err) => {
  log.error("job failed", {
    worker: "queue",
    jobName: job?.name ?? undefined,
    jobId: job?.id ?? undefined,
    error: err.message,
  });
});

worker.on("error", (err) => {
  log.error("connection error", { worker: "queue", error: err.message });
});

log.info("worker online", {
  worker: "queue",
  queue: DOCUMENT_QUEUE_NAME,
  pid: process.pid,
});

// Housekeeping: keep the `Log` table trimmed. Idempotent — multiple
// worker processes or a restart won't stack duplicate schedules
// because the repeatable uses a stable jobId. A startup-time prune
// fires immediately so a long worker-down window doesn't keep the
// table bloated until the next 6 h tick.
void registerPruneLogsRepeatable().catch((err) => {
  log.error("failed to register prune-logs repeatable", {
    worker: "queue",
    error: err instanceof Error ? err.message : String(err),
  });
});

// Graceful shutdown — BullMQ finishes in-flight jobs on close.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    log.info("shutting down", { worker: "queue", signal });
    await worker.close();
    process.exit(0);
  });
}
