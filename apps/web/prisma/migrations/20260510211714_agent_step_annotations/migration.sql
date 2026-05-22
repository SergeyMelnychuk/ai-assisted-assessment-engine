-- CreateTable
CREATE TABLE "agent_step_annotations" (
    "id" TEXT NOT NULL,
    "step_id" TEXT NOT NULL,
    "author_id" TEXT,
    "body" TEXT NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "resolved_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_step_annotations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_step_annotations_step_id_idx" ON "agent_step_annotations"("step_id");

-- AddForeignKey
ALTER TABLE "agent_step_annotations" ADD CONSTRAINT "agent_step_annotations_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "agent_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
