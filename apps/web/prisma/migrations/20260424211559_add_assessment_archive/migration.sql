-- AlterTable
ALTER TABLE "assessments" ADD COLUMN     "archived_at" TIMESTAMP(3),
ADD COLUMN     "archived_by_id" TEXT;
