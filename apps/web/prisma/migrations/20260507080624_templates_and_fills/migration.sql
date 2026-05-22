-- CreateEnum
CREATE TYPE "TemplateKind" AS ENUM ('ESTIMATION', 'DELIVERABLE_REPORT', 'DELIVERABLE_PRESENTATION');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('PROPOSED', 'APPROVED', 'DEPRECATED');

-- CreateTable
CREATE TABLE "templates" (
    "id" TEXT NOT NULL,
    "engagement_id" TEXT,
    "kind" "TemplateKind" NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "storage_path" TEXT NOT NULL,
    "binding_json" JSONB,
    "status" "TemplateStatus" NOT NULL DEFAULT 'PROPOSED',
    "uploaded_by_id" TEXT NOT NULL,
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "deprecated_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_fills" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "assessment_id" TEXT NOT NULL,
    "binding_snapshot" JSONB,
    "output_document_id" TEXT,
    "inputs_snapshot" JSONB,
    "filled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filled_by_id" TEXT,

    CONSTRAINT "template_fills_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "templates_engagement_id_kind_status_idx" ON "templates"("engagement_id", "kind", "status");

-- CreateIndex
CREATE INDEX "templates_kind_status_idx" ON "templates"("kind", "status");

-- CreateIndex
CREATE INDEX "template_fills_template_id_idx" ON "template_fills"("template_id");

-- CreateIndex
CREATE INDEX "template_fills_assessment_id_idx" ON "template_fills"("assessment_id");

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_engagement_id_fkey" FOREIGN KEY ("engagement_id") REFERENCES "engagements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_fills" ADD CONSTRAINT "template_fills_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_fills" ADD CONSTRAINT "template_fills_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_fills" ADD CONSTRAINT "template_fills_output_document_id_fkey" FOREIGN KEY ("output_document_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
