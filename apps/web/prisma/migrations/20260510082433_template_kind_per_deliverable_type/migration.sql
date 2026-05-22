-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TemplateKind" ADD VALUE 'EXECUTIVE_SUMMARY';
ALTER TYPE "TemplateKind" ADD VALUE 'ASSESSMENT_REPORT';
ALTER TYPE "TemplateKind" ADD VALUE 'RISK_REGISTER';
ALTER TYPE "TemplateKind" ADD VALUE 'TARGET_STATE';
ALTER TYPE "TemplateKind" ADD VALUE 'ROADMAP';
ALTER TYPE "TemplateKind" ADD VALUE 'TEAM_PROPOSAL';
ALTER TYPE "TemplateKind" ADD VALUE 'ESTIMATE';
ALTER TYPE "TemplateKind" ADD VALUE 'ASSUMPTIONS_GAPS';
ALTER TYPE "TemplateKind" ADD VALUE 'SOW_DRAFT';
ALTER TYPE "TemplateKind" ADD VALUE 'GREENFIELD_DISCOVERY';
