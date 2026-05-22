/**
 * Trajectory writer — ADR-0014 §6.
 *
 * Thin wrapper over the `AgentRun` / `AgentStep` / `AgentToolCall` Prisma
 * tables. The replay invariant in ADR-0014 §6 — "concatenation of
 * AgentStep rows in stepIdx order plus captured AgentToolCall outputs
 * reconstructs exactly what the model saw at every turn" — is this
 * module's responsibility. Every write goes through here so that
 * invariant is enforced in one place.
 *
 * The Prisma model accessor types (`AgentRun`, etc.) are now generated;
 * we re-export the enum unions so harness/tool callers don't have to
 * import from `@prisma/client` directly.
 */

import type { PrismaClient } from "@prisma/client";
import {
  Prisma,
  AgentRunStatus as PrismaAgentRunStatus,
  AgentStepKind as PrismaAgentStepKind,
  ToolCallStatus as PrismaToolCallStatus,
} from "@prisma/client";

export type AgentRunStatus = PrismaAgentRunStatus;
export type AgentStepKind = PrismaAgentStepKind;
export type ToolCallStatus = PrismaToolCallStatus;

export interface CreateRunInput {
  assessmentId: string;
  engagementId: string;
  planName: string;
  systemPrompt: string;
  systemPromptSha: string;
  model: string;
  modelFallback?: string;
  budget: Prisma.InputJsonValue;
}

/** Creates an `AgentRun` row in PROPOSED status; returns the new runId. */
export async function createRun(
  db: PrismaClient,
  input: CreateRunInput,
): Promise<string> {
  const row = await db.agentRun.create({
    data: {
      assessmentId: input.assessmentId,
      engagementId: input.engagementId,
      planName: input.planName,
      status: PrismaAgentRunStatus.PROPOSED,
      budget: input.budget,
      usage: {} as Prisma.InputJsonValue,
      systemPrompt: input.systemPrompt,
      systemPromptSha: input.systemPromptSha,
      model: input.model,
      modelFallback: input.modelFallback ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Append one `AgentStep` to a run and return the assigned `idx`.
 * `payload` is persisted verbatim per the §6 replay invariant.
 *
 * `idx` is computed as `max(idx)+1` inside a serialisable transaction so
 * concurrent appends can't collide on the `(runId, idx)` unique. In
 * practice the harness is single-writer per run (the BullMQ job holds
 * the run), but two harness deployments racing on the same row would be
 * a silent corruption otherwise.
 */
export async function appendStep(
  db: PrismaClient,
  runId: string,
  kind: AgentStepKind,
  payload: Prisma.InputJsonValue,
  tokens?: { input?: number; output?: number; cached?: number },
): Promise<{ id: string; idx: number }> {
  return db.$transaction(async (tx) => {
    const last = await tx.agentStep.findFirst({
      where: { runId },
      orderBy: { idx: "desc" },
      select: { idx: true },
    });
    const nextIdx = (last?.idx ?? -1) + 1;
    const created = await tx.agentStep.create({
      data: {
        runId,
        idx: nextIdx,
        kind,
        payload,
        inputTokens: tokens?.input ?? 0,
        outputTokens: tokens?.output ?? 0,
      },
      select: { id: true, idx: true },
    });
    return created;
  });
}

/**
 * Record a dispatched tool call on a step. Returns the new
 * `AgentToolCall.id` so the harness can patch it with `updateToolCall`
 * once execution completes. Starts in PENDING with `startedAt = now`.
 */
export async function recordToolCall(
  db: PrismaClient,
  stepId: string,
  toolName: string,
  args: Prisma.InputJsonValue,
): Promise<string> {
  const row = await db.agentToolCall.create({
    data: {
      stepId,
      toolName,
      argsJson: args,
      status: PrismaToolCallStatus.PENDING,
      startedAt: new Date(),
    },
    select: { id: true },
  });
  return row.id;
}

export interface UpdateToolCallPatch {
  status: ToolCallStatus;
  result?: Prisma.InputJsonValue;
  errorClass?: string;
  durationMs?: number;
  evidenceIds?: readonly string[];
}

/** Patch a tool call after execution. */
export async function updateToolCall(
  db: PrismaClient,
  id: string,
  patch: UpdateToolCallPatch,
): Promise<void> {
  await db.agentToolCall.update({
    where: { id },
    data: {
      status: patch.status,
      endedAt: new Date(),
      durationMs: patch.durationMs ?? null,
      resultJson: patch.result ?? Prisma.JsonNull,
      errorClass: patch.errorClass ?? null,
      evidenceIds:
        patch.evidenceIds !== undefined ? [...patch.evidenceIds] : undefined,
    },
  });
}

/**
 * Mark a run finished (or paused). `endReason` mirrors the ADR's
 * vocabulary (`COMPLETED` / `BUDGET_EXHAUSTED` / `CANCELLED` / `FAILED`
 * / `AWAITING_USER`). Sets `endedAt` only on terminal states; an
 * AWAITING_USER pause is a suspension, not an end.
 */
export async function finishRun(
  db: PrismaClient,
  runId: string,
  status: AgentRunStatus,
  endReason?: string,
  errorDetails?: Prisma.InputJsonValue,
): Promise<void> {
  const terminal =
    status === PrismaAgentRunStatus.COMPLETED ||
    status === PrismaAgentRunStatus.BUDGET_EXHAUSTED ||
    status === PrismaAgentRunStatus.CANCELLED ||
    status === PrismaAgentRunStatus.FAILED;
  await db.agentRun.update({
    where: { id: runId },
    data: {
      status,
      endReason: endReason ?? null,
      endedAt: terminal ? new Date() : null,
      errorDetails: errorDetails ?? Prisma.JsonNull,
    },
  });
}

/** Mark a run RUNNING with `startedAt = now` (idempotent on repeats). */
export async function markRunning(
  db: PrismaClient,
  runId: string,
): Promise<void> {
  await db.agentRun.update({
    where: { id: runId },
    data: {
      status: PrismaAgentRunStatus.RUNNING,
      startedAt: new Date(),
    },
  });
}
