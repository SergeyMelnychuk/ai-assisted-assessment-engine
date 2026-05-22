-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR');

-- DropIndex
DROP INDEX "evidences_embedding_hnsw_idx";

-- CreateTable
CREATE TABLE "logs" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" "LogLevel" NOT NULL,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" JSONB,
    "user_id" TEXT,
    "assessment_id" TEXT,
    "job_id" TEXT,
    "error" TEXT,

    CONSTRAINT "logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "logs_created_at_idx" ON "logs"("created_at");

-- CreateIndex
CREATE INDEX "logs_level_created_at_idx" ON "logs"("level", "created_at");

-- CreateIndex
CREATE INDEX "logs_source_idx" ON "logs"("source");

-- CreateIndex
CREATE INDEX "logs_assessment_id_idx" ON "logs"("assessment_id");

-- CreateIndex
CREATE INDEX "logs_job_id_idx" ON "logs"("job_id");
