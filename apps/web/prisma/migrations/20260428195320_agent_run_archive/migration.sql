-- AlterTable
ALTER TABLE "agent_runs" ADD COLUMN     "archived_at" TIMESTAMP(3),
ADD COLUMN     "archived_by_id" TEXT;
