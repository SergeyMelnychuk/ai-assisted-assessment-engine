-- CreateEnum
CREATE TYPE "WorkflowStepExplicitStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- AlterTable
ALTER TABLE "repository_links" ADD COLUMN     "agent_credential_id" TEXT,
ALTER COLUMN "encrypted_credentials" DROP NOT NULL,
ALTER COLUMN "credentials_iv" DROP NOT NULL,
ALTER COLUMN "credentials_tag" DROP NOT NULL;

-- CreateTable
CREATE TABLE "workflow_step_status" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    "status" "WorkflowStepExplicitStatus" NOT NULL,
    "note" TEXT,
    "updated_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_step_status_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "workflow_step_status_run_id_idx" ON "workflow_step_status"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_step_status_run_id_node_id_key" ON "workflow_step_status"("run_id", "node_id");

-- CreateIndex
CREATE INDEX "repository_links_agent_credential_id_idx" ON "repository_links"("agent_credential_id");

-- AddForeignKey
ALTER TABLE "repository_links" ADD CONSTRAINT "repository_links_agent_credential_id_fkey" FOREIGN KEY ("agent_credential_id") REFERENCES "agent_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_step_status" ADD CONSTRAINT "workflow_step_status_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
