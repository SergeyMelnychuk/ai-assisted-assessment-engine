import { Queue } from "bullmq";
import IORedis from "ioredis";

/**
 * BullMQ queue & shared Redis connection for the background-job pipeline.
 *
 * As of Phase 3 Week 1 (ADR-0001) ingest is decoupled from analyse:
 *
 *   - `ingest-document` — download → extract text → chunk → insert
 *     Evidence rows. **No Claude call.** Was `process-document`.
 *   - `ingest-diagram`  — parse source (Mermaid/PlantUML/Structurizr)
 *     or Claude-vision on a diagram image. Was `process-diagram`.
 *     (Diagrams still call Claude vision because the raster path has
 *     no chunking equivalent; per-doc text analysis no longer runs.)
 *   - `run-analysis`    — unchanged; owns all per-assessment AI work.
 *
 * One queue keeps ordering predictable and backpressure uniform. If we
 * ever need separate concurrency tuning (e.g. throttle vision calls
 * harder than text-extraction), split into two queues then.
 */

export const DOCUMENT_QUEUE_NAME = "document-processing";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

const globalForQueue = globalThis as unknown as {
  redisConnection: IORedis | undefined;
  documentQueue: Queue<DocumentJobData> | undefined;
};

// maxRetriesPerRequest MUST be null for BullMQ — it uses a blocking BRPOPLPUSH
// loop that IORedis would otherwise treat as a hung command and retry to death.
export const redisConnection =
  globalForQueue.redisConnection ??
  new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

if (process.env.NODE_ENV !== "production") {
  globalForQueue.redisConnection = redisConnection;
}

export type DocumentJobData =
  | { type: "ingest-document"; documentId: string }
  | { type: "ingest-diagram"; documentId: string }
  // Week 5 (ADR-0008): archive parent is its own job that stream-
  // extracts members and fans out `ingest-document` for each survivor.
  | { type: "ingest-archive"; documentId: string; s3Key: string }
  // Week 6 (ADR-0009/0010): repo-link ingest. Fetches the tarball,
  // persists a parent Document, then hands off to `ingest-archive`
  // which fans out per-file children.
  | { type: "ingest-repository"; repositoryLinkId: string }
  | { type: "generate-follow-ups"; assessmentId: string }
  // `mode` added Phase 3 Week 9 (ADR-0013). FAST / THOROUGH selects
  // whether the per-domain verifier pass runs. Absent on legacy jobs
  // queued before the migration → the handler defaults to FAST.
  | {
      type: "run-analysis";
      assessmentId: string;
      mode?: "FAST" | "THOROUGH";
    }
  | { type: "run-estimation"; assessmentId: string; templateId?: string }
  | {
      type: "generate-deliverable";
      assessmentId: string;
      deliverableType: string;
      templateId?: string;
    }
  // Housekeeping: deletes rows older than `LOG_RETENTION_DAYS` from
  // the `Log` table. Registered as a repeatable job on worker start-
  // up (see `registerPruneLogsRepeatable`) — callers should not
  // enqueue this manually.
  | { type: "prune-logs" }
  // Phase 4 (ADR-0014): the agent harness. One job per dispatch — both
  // initial start AND post-credential resume go through the same path
  // so the harness logic is single-writer per run. The processor reads
  // the run's current state from Prisma; nothing run-specific lives in
  // the job payload beyond the runId.
  | { type: "agent-harness"; runId: string }
  // Phase 4: customer-uploadable templates. After upload the proposer
  // job runs the AI binding pass and writes the result onto
  // `Template.bindingJson` for human review.
  //
  // The `isRepropose`, `feedback`, and `priorBinding` fields are
  // populated by the `template.reproposeBinding` mutation. They drive
  // two re-propose modes inside the job:
  //   - **Refine** (`priorBinding` set): the AI starts from the
  //     existing binding and revises it according to feedback.
  //   - **From scratch** (`priorBinding` absent, `isRepropose: true`):
  //     the AI ignores the prior binding entirely and proposes a
  //     fresh one. Used when the existing binding is corrupted past
  //     the point where refining helps.
  // `isRepropose: true` also tells the job to bypass its "skip when
  // bindingJson already exists" guard — without it, every re-propose
  // would be silently dropped because the row already has a binding.
  | {
      type: "propose-template-binding";
      templateId: string;
      isRepropose?: boolean;
      feedback?: string;
      priorBinding?: unknown;
    };

export const documentQueue =
  globalForQueue.documentQueue ??
  new Queue<DocumentJobData>(DOCUMENT_QUEUE_NAME, {
    connection: redisConnection,
    defaultJobOptions: {
      // attempts=1 → no automatic retry. Every AI-touching job costs real
      // Anthropic tokens, and transient failures (429/529, truncation,
      // malformed output) cost just as many tokens to hit the wall a
      // second time. The user decides when to retry via the UI buttons
      // (document.reprocess, analysis.run, etc.) so token spend stays
      // under human control.
      attempts: 1,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    },
  });

if (process.env.NODE_ENV !== "production") {
  globalForQueue.documentQueue = documentQueue;
}

/**
 * Enqueue a document ingest job. Returns the job id so the caller can
 * correlate it with log lines if needed.
 */
// BullMQ forbids `:` in custom job IDs (it uses them as key separators in
// Redis), so we namespace with `-` instead. The `doc-` / `diag-` prefix
// also disambiguates if a single document ever re-enqueues both job types
// (e.g. re-upload swap from doc → diagram).
export async function enqueueIngestDocument(documentId: string): Promise<string> {
  const job = await documentQueue.add(
    "ingest-document",
    { type: "ingest-document", documentId },
    { jobId: `doc-${documentId}` },
  );
  return job.id ?? `doc-${documentId}`;
}

/**
 * Enqueue an archive-ingest job (Week 5, ADR-0008). The parent Document
 * row must already exist in PENDING. The worker stream-extracts members
 * and fans out `ingest-document` jobs for each survivor; safety gates
 * bail on first violation with a classified error.
 */
export async function enqueueIngestArchive(
  documentId: string,
  s3Key: string,
): Promise<string> {
  const job = await documentQueue.add(
    "ingest-archive",
    { type: "ingest-archive", documentId, s3Key },
    { jobId: `arch-${documentId}` },
  );
  return job.id ?? `arch-${documentId}`;
}

/**
 * Enqueue a repo-link ingest job (Week 6, ADR-0009/0010). The
 * `RepositoryLink` row must already exist in PENDING. The worker
 * decrypts the PAT, fetches the tarball via the provider, persists
 * it as a parent Document, and enqueues `ingest-archive` to do the
 * per-file fan-out. Timestamped jobId so re-sync clicks don't
 * collide.
 */
export async function enqueueIngestRepository(
  repositoryLinkId: string,
): Promise<string> {
  const job = await documentQueue.add(
    "ingest-repository",
    { type: "ingest-repository", repositoryLinkId },
    { jobId: `repo-${repositoryLinkId}-${Date.now()}` },
  );
  return job.id ?? `repo-${repositoryLinkId}`;
}

export async function enqueueIngestDiagram(documentId: string): Promise<string> {
  const job = await documentQueue.add(
    "ingest-diagram",
    { type: "ingest-diagram", documentId },
    { jobId: `diag-${documentId}` },
  );
  return job.id ?? `diag-${documentId}`;
}

/**
 * Follow-up generation is keyed by assessment so we can collapse a burst
 * of answers into a single AI call. The `jobId` ensures BullMQ dedupes
 * concurrent requests — a second answer arriving before the job runs
 * doesn't stack a second AI call on top of it.
 */
export async function enqueueGenerateFollowUps(
  assessmentId: string,
): Promise<string> {
  const job = await documentQueue.add(
    "generate-follow-ups",
    { type: "generate-follow-ups", assessmentId },
    {
      jobId: `followups-${assessmentId}`,
      // Small debounce so multiple rapid answers batch into one job.
      delay: 1_500,
    },
  );
  return job.id ?? `followups-${assessmentId}`;
}

/**
 * Analysis run — keyed by assessment so repeat clicks on "Run analysis"
 * coalesce. BullMQ silently returns the existing job when the same
 * `jobId` is already queued or running, so double-clicks and nervous
 * retry-tabs can't stack a second expensive 8-domain fan-out on top of
 * the first.
 *
 * Previously the jobId carried a `Date.now()` suffix so every click
 * produced a distinct job — that let cancel-and-retry bursts through
 * without clashing, but it also let "user clicked Run twice" spawn
 * two independent runs back-to-back (observed 2026-04-19: one
 * cancelled mid-first-domain, then a full 8-domain re-run). Stable id
 * is the right trade: re-clicks during an active run are no-ops; a
 * click after a terminal state (success / failed / cancelled) uses
 * the same id but `removeOnComplete` / `removeOnFail` have already
 * evicted the old record, so the new job enqueues cleanly.
 *
 * Users who need to force a fresh run while the old one is still
 * pending can cancel it via the UI first — the terminal audit row
 * frees the slot.
 */
export async function enqueueRunAnalysis(
  assessmentId: string,
  mode: "FAST" | "THOROUGH" = "FAST",
): Promise<string> {
  const job = await documentQueue.add(
    "run-analysis",
    { type: "run-analysis", assessmentId, mode },
    {
      jobId: `analysis-${assessmentId}`,
      // No delay — user-initiated, should fire immediately.
    },
  );
  return job.id ?? `analysis-${assessmentId}`;
}

/**
 * Team & estimate generation — separate job type from analysis because
 * the user may want to re-run estimation without re-running findings
 * (e.g. after manually editing a couple of findings they want fed back
 * into the team proposal).
 */
export async function enqueueRunEstimation(
  assessmentId: string,
  templateId?: string,
): Promise<string> {
  const job = await documentQueue.add(
    "run-estimation",
    { type: "run-estimation", assessmentId, templateId },
    {
      jobId: `estimation-${assessmentId}-${Date.now()}`,
    },
  );
  return job.id ?? `estimation-${assessmentId}`;
}

/**
 * Deliverable generation — the heavyweight run (N diagrams + N sections).
 * Timestamped jobId keeps re-runs from colliding; the service layer
 * already handles "replace DRAFT rows, preserve reviewed" so concurrent
 * clicks don't corrupt state.
 */
export async function enqueueGenerateDeliverable(
  assessmentId: string,
  deliverableType: string,
  templateId?: string,
): Promise<string> {
  const job = await documentQueue.add(
    "generate-deliverable",
    {
      type: "generate-deliverable",
      assessmentId,
      deliverableType,
      templateId,
    },
    {
      jobId: `deliverable-${assessmentId}-${deliverableType}-${Date.now()}`,
    },
  );
  return job.id ?? `deliverable-${assessmentId}`;
}

/**
 * Idempotently registers the `prune-logs` housekeeping job as a BullMQ
 * repeatable. Called once at worker start-up. The fixed `jobId` +
 * `every` key make BullMQ treat repeat re-registrations as no-ops, so
 * multiple worker processes (or a worker restart) don't stack duplicate
 * schedules. Fires every 6 hours — `Log` table grows linearly with
 * traffic and a 6 h cadence keeps at most one quarter-day of stale
 * rows past the retention window.
 */
export const PRUNE_LOGS_REPEAT_EVERY_MS = 6 * 60 * 60 * 1000;

export async function registerPruneLogsRepeatable(): Promise<void> {
  await documentQueue.add(
    "prune-logs",
    { type: "prune-logs" },
    {
      repeat: { every: PRUNE_LOGS_REPEAT_EVERY_MS },
      // Stable jobId so BullMQ's repeat-scheduler treats this as the
      // same recurring entry across restarts. Without it each worker
      // boot would register a brand-new schedule.
      jobId: "prune-logs-repeat",
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 20 },
    },
  );
  // Kick off an immediate one-shot too so a long worker-down window
  // doesn't leave the table bloated until the next 6 h tick. Stamped
  // with `Date.now()` to avoid colliding with the repeatable's jobId.
  await documentQueue.add(
    "prune-logs",
    { type: "prune-logs" },
    {
      jobId: `prune-logs-startup-${Date.now()}`,
      removeOnComplete: true,
      removeOnFail: { count: 5 },
    },
  );
}

/**
 * Enqueue an agent-harness dispatch (ADR-0014).
 *
 * Stamped jobId per dispatch (`agent-${runId}-${Date.now()}`). We
 * USED to use a stable `agent-${runId}` here so concurrent enqueues
 * would dedup at the queue layer, but that was a bug:
 *
 *   - start → harness pauses on AWAITING_USER → returns void → BullMQ
 *     records the job as COMPLETED.
 *   - With `removeOnComplete: { count: 100 }`, completed jobs stay in
 *     the queue's history.
 *   - submitCredential → enqueue with same jobId → BullMQ sees the
 *     completed record and silently returns it WITHOUT re-dispatching.
 *
 * Net: paused runs never resumed. Stamped jobId fixes that — every
 * dispatch becomes a fresh job. Concurrent dispatches on the same run
 * are still bounded: the harness loads `AgentRun` from Prisma at the
 * top, marks RUNNING, and the trajectory's step counter is monotonic
 * (it counts existing TOOL_CALL steps) so two racing harness instances
 * would at worst plan an extra turn each, not corrupt state.
 *
 * Future hardening: a Postgres advisory lock keyed on `runId` taken at
 * the top of `runAgent` would make even that theoretical race
 * impossible. Out of scope for v1.
 */
export async function enqueueAgentHarness(runId: string): Promise<string> {
  const jobId = `agent-${runId}-${Date.now()}`;
  const job = await documentQueue.add(
    "agent-harness",
    { type: "agent-harness", runId },
    { jobId },
  );
  return job.id ?? jobId;
}

/**
 * Enqueue an AI binding-proposer pass for a freshly-uploaded template.
 * The job loads the file from MinIO, extracts a small structural
 * sample, asks Claude to map cells/placeholders to engine outputs,
 * and writes the resulting binding JSON back onto the Template row.
 *
 * Stamped jobId per dispatch — re-running the proposer on the same
 * template (e.g. after a model swap) should not be deduped against an
 * earlier completed run.
 */
export async function enqueueProposeTemplateBinding(
  templateId: string,
  opts: {
    isRepropose?: boolean;
    feedback?: string;
    priorBinding?: unknown;
  } = {},
): Promise<string> {
  const jobId = `tpl-bind-${templateId}-${Date.now()}`;
  const job = await documentQueue.add(
    "propose-template-binding",
    {
      type: "propose-template-binding",
      templateId,
      isRepropose: opts.isRepropose,
      feedback: opts.feedback,
      priorBinding: opts.priorBinding,
    },
    { jobId },
  );
  return job.id ?? jobId;
}

/**
 * Legacy aliases — retained so any caller still reaching for the old
 * names compiles. New code should use the `ingest*` variants.
 * @deprecated Use `enqueueIngestDocument` / `enqueueIngestDiagram`.
 */
export const enqueueProcessDocument = enqueueIngestDocument;
export const enqueueProcessDiagram = enqueueIngestDiagram;
