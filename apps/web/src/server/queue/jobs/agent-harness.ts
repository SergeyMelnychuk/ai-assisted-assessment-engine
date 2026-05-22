/**
 * Agent harness queue processor — ADR-0014.
 *
 * One job per dispatch (start OR resume after credential submission).
 * The processor is a thin shim over `runAgent` from the harness:
 * everything stateful lives on the `AgentRun` row + trajectory tables,
 * so the job payload only needs the run id.
 *
 * Idempotency: BullMQ collapses concurrent `agent-${runId}` enqueues
 * into one job (see `enqueueAgentHarness`). The harness itself reads
 * the trajectory's current step count to resume from the right place
 * — running the same job twice in a row produces the same trajectory.
 *
 * Errors: a thrown error here flips the run to FAILED (the harness
 * already does this on every internal failure path; if we reach the
 * outer catch it means the harness itself broke, not a tool). The
 * BullMQ job is recorded as failed at the queue layer too. With
 * `attempts: 1` (queue default) there's no auto-retry — the user
 * decides via the UI whether to start a new run.
 */

import { db } from "@/server/db";
import { log } from "@/server/lib/logger";
import {
  AgentRunStatus,
  CredentialRequestStatus,
} from "@prisma/client";
import { runAgent } from "@/server/services/agent";

export async function agentHarnessJob(runId: string): Promise<void> {
  log.info("agent harness start", { worker: "agent-harness", runId });

  try {
    const result = await runAgent({ db, runId });

    log.info("agent harness done", {
      worker: "agent-harness",
      runId,
      status: result.status,
      endReason: result.endReason,
    });

    // Best-effort audit on terminal states. We don't audit
    // AWAITING_USER pauses — the credential request row + the run's
    // status flip are already the trail.
    const isTerminal =
      result.status === AgentRunStatus.COMPLETED ||
      result.status === AgentRunStatus.FAILED ||
      result.status === AgentRunStatus.BUDGET_EXHAUSTED ||
      result.status === AgentRunStatus.CANCELLED;
    if (isTerminal) {
      const run = await db.agentRun.findUnique({
        where: { id: runId },
        select: { assessmentId: true, engagementId: true },
      });
      await db.auditLog
        .create({
          data: {
            action: `AGENT_RUN_${result.status}`,
            entityType: "AgentRun",
            entityId: runId,
            details: {
              endReason: result.endReason,
              assessmentId: run?.assessmentId,
              engagementId: run?.engagementId,
            },
          },
        })
        .catch(() => {
          /* best-effort */
        });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("agent harness threw", {
      worker: "agent-harness",
      runId,
      error: message,
    });
    // Force the run into a terminal state so the UI clears the spinner.
    // We swallow errors from this update — if the row's already gone
    // (cascade from an assessment delete), there's nothing to fix.
    await db.agentRun
      .update({
        where: { id: runId },
        data: {
          status: AgentRunStatus.FAILED,
          endedAt: new Date(),
          endReason: "harness threw",
          errorDetails: { message },
        },
      })
      .catch(() => {
        /* best-effort */
      });
    // Drop any outstanding credential requests so the UI prompt clears.
    await db.agentCredentialRequest
      .updateMany({
        where: { runId, status: CredentialRequestStatus.PENDING },
        data: { status: CredentialRequestStatus.SUPERSEDED },
      })
      .catch(() => {
        /* best-effort */
      });
    throw err;
  }
}
