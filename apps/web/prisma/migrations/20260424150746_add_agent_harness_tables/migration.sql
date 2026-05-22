-- CreateEnum
CREATE TYPE "EvidenceMode" AS ENUM ('MANUAL', 'AGENTIC');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('PROPOSED', 'APPROVED', 'RUNNING', 'AWAITING_USER', 'COMPLETED', 'BUDGET_EXHAUSTED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "AgentStepKind" AS ENUM ('PLAN', 'TOOL_CALL', 'ASSISTANT', 'USER_INPUT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ToolCallStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED');

-- AlterTable
ALTER TABLE "assessments" ADD COLUMN     "evidence_mode" "EvidenceMode" NOT NULL DEFAULT 'MANUAL';

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL,
    "assessment_id" TEXT NOT NULL,
    "engagement_id" TEXT NOT NULL,
    "plan_name" TEXT NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'PROPOSED',
    "budget" JSONB NOT NULL,
    "usage" JSONB NOT NULL DEFAULT '{}',
    "system_prompt" TEXT NOT NULL,
    "system_prompt_sha" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "model_fallback" TEXT,
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "end_reason" TEXT,
    "error_details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_steps" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "kind" "AgentStepKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_tool_calls" (
    "id" TEXT NOT NULL,
    "step_id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "args_json" JSONB NOT NULL,
    "status" "ToolCallStatus" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "result_json" JSONB,
    "error_class" TEXT,
    "evidence_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "agent_tool_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_runs_assessment_id_idx" ON "agent_runs"("assessment_id");

-- CreateIndex
CREATE INDEX "agent_runs_engagement_id_created_at_idx" ON "agent_runs"("engagement_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_steps_run_id_idx_key" ON "agent_steps"("run_id", "idx");

-- CreateIndex
CREATE INDEX "agent_tool_calls_tool_name_status_idx" ON "agent_tool_calls"("tool_name", "status");

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_engagement_id_fkey" FOREIGN KEY ("engagement_id") REFERENCES "engagements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "agent_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
