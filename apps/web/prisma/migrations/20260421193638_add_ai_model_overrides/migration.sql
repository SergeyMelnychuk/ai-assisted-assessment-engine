-- CreateTable
CREATE TABLE "ai_model_overrides" (
    "id" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "binding" JSONB NOT NULL,
    "fallbacks" JSONB NOT NULL DEFAULT '[]',
    "reason" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "ai_model_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_model_overrides_task_key" ON "ai_model_overrides"("task");
