-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'ASSESSOR', 'REVIEWER', 'VIEWER');

-- CreateEnum
CREATE TYPE "EngagementStatus" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "EngagementRole" AS ENUM ('OWNER', 'CONTRIBUTOR', 'REVIEWER', 'VIEWER');

-- CreateEnum
CREATE TYPE "AssessmentMode" AS ENUM ('EXISTING_SYSTEM', 'GREENFIELD', 'MODERNIZATION', 'AUDIT', 'PRE_IMPLEMENTATION');

-- CreateEnum
CREATE TYPE "AssessmentStage" AS ENUM ('SETUP', 'INTAKE', 'QUESTIONING', 'ANALYSIS', 'DRAFTING', 'REVIEW', 'COMPLETED');

-- CreateEnum
CREATE TYPE "BudgetSensitivity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('RFP', 'ARCHITECTURE_DOC', 'NFR_DOC', 'BACKLOG', 'API_SPEC', 'DIAGRAM_STRUCTURIZR', 'DIAGRAM_MERMAID', 'DIAGRAM_PLANTUML', 'DIAGRAM_WEBSEQUENCE', 'DIAGRAM_IMAGE', 'DIAGRAM_SVG', 'DIAGRAM_OTHER', 'MEETING_NOTES', 'INCIDENT_SUMMARY', 'SECURITY_DOC', 'OPERATIONAL_MANUAL', 'MIGRATION_NOTES', 'PROPOSAL', 'OTHER');

-- CreateEnum
CREATE TYPE "ProcessingStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "DiagramDirection" AS ENUM ('INGESTED', 'GENERATED');

-- CreateEnum
CREATE TYPE "DiagramFormat" AS ENUM ('STRUCTURIZR', 'MERMAID', 'PLANTUML', 'WEBSEQUENCEDIAGRAMS', 'PNG', 'SVG', 'JPEG', 'DRAW_IO', 'OTHER');

-- CreateEnum
CREATE TYPE "DiagramContentType" AS ENUM ('SYSTEM_CONTEXT', 'CONTAINER', 'COMPONENT', 'DEPLOYMENT', 'SEQUENCE', 'DATA_FLOW', 'NETWORK_TOPOLOGY', 'ER_DIAGRAM', 'STATE_MACHINE', 'ACTIVITY_FLOW', 'INFRASTRUCTURE', 'OTHER');

-- CreateEnum
CREATE TYPE "EvidenceSourceType" AS ENUM ('DOCUMENT', 'ANSWER', 'ARTIFACT', 'CONNECTOR');

-- CreateEnum
CREATE TYPE "ConnectorType" AS ENUM ('REPOSITORY', 'IAC_REPO', 'CICD', 'CLOUD_CONFIG', 'K8S', 'MONITORING', 'TEST_REPORT', 'DATABASE_SCHEMA', 'BACKLOG_SYSTEM', 'DOCUMENTATION');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('PENDING_APPROVAL', 'CONNECTED', 'FAILED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "ValidationStatus" AS ENUM ('CONFIRMED', 'CONTRADICTED', 'PARTIALLY_CONFIRMED', 'INCONCLUSIVE');

-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('SINGLE_CHOICE', 'MULTI_CHOICE', 'FREE_TEXT', 'NUMERIC', 'FILE_UPLOAD', 'CONFIRMATION');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "GeneratedBy" AS ENUM ('AI', 'TEMPLATE', 'MANUAL');

-- CreateEnum
CREATE TYPE "QuestionStage" AS ENUM ('INTAKE', 'FOLLOW_UP', 'CLARIFICATION', 'EVIDENCE_REQUEST');

-- CreateEnum
CREATE TYPE "MaturityLevel" AS ENUM ('AD_HOC', 'INITIAL', 'DEFINED', 'MANAGED', 'OPTIMIZED');

-- CreateEnum
CREATE TYPE "FindingType" AS ENUM ('STRENGTH', 'WEAKNESS', 'GAP', 'OBSERVATION', 'OPPORTUNITY');

-- CreateEnum
CREATE TYPE "Likelihood" AS ENUM ('VERY_LIKELY', 'LIKELY', 'POSSIBLE', 'UNLIKELY');

-- CreateEnum
CREATE TYPE "AssumptionSource" AS ENUM ('AI_INFERRED', 'STAKEHOLDER_STATED', 'EVIDENCE_BASED');

-- CreateEnum
CREATE TYPE "Seniority" AS ENUM ('JUNIOR', 'MID', 'SENIOR', 'LEAD', 'PRINCIPAL');

-- CreateEnum
CREATE TYPE "DeliverableType" AS ENUM ('EXECUTIVE_SUMMARY', 'ASSESSMENT_REPORT', 'RISK_REGISTER', 'TARGET_STATE', 'ROADMAP', 'TEAM_PROPOSAL', 'ESTIMATE', 'ASSUMPTIONS_GAPS', 'SOW_DRAFT', 'GREENFIELD_DISCOVERY');

-- CreateEnum
CREATE TYPE "DeliverableStatus" AS ENUM ('GENERATING', 'DRAFT', 'IN_REVIEW', 'APPROVED', 'EXPORTED');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'NEEDS_REVISION');

-- CreateEnum
CREATE TYPE "ReviewAction" AS ENUM ('APPROVE', 'REJECT', 'EDIT', 'REQUEST_REVISION');

-- CreateEnum
CREATE TYPE "KnowledgeArtifactType" AS ENUM ('FRAMEWORK', 'CHECKLIST', 'TEMPLATE', 'HEURISTIC', 'RISK_PATTERN', 'RECOMMENDATION_PATTERN', 'ROLE_CATALOG', 'RATE_CARD', 'TECHNOLOGY_OPTION', 'PLATFORM_GUIDANCE', 'CAPABILITY_MODEL', 'SCORING_MODEL', 'INDUSTRY_OVERLAY', 'CLOUD_OVERLAY', 'QUESTION_TEMPLATE');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'ASSESSOR',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagements" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "client_name" TEXT NOT NULL,
    "industry" TEXT,
    "status" "EngagementStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "engagements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement_members" (
    "id" TEXT NOT NULL,
    "engagement_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "EngagementRole" NOT NULL DEFAULT 'CONTRIBUTOR',

    CONSTRAINT "engagement_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessments" (
    "id" TEXT NOT NULL,
    "engagement_id" TEXT NOT NULL,
    "assessment_type_id" TEXT NOT NULL,
    "mode" "AssessmentMode" NOT NULL,
    "status" "AssessmentStage" NOT NULL DEFAULT 'SETUP',
    "active_domains" TEXT[],
    "overall_confidence" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_types" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "default_domains" TEXT[],
    "default_mode" "AssessmentMode" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assessment_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_contexts" (
    "id" TEXT NOT NULL,
    "assessment_id" TEXT NOT NULL,
    "project_name" TEXT,
    "description" TEXT,
    "industry" TEXT,
    "cloud_providers" TEXT[],
    "platforms" TEXT[],
    "known_constraints" TEXT,
    "business_goals" TEXT,
    "expected_timeline" TEXT,
    "budget_sensitivity" "BudgetSensitivity",
    "target_delivery_model" TEXT,
    "estimated_users" TEXT,
    "compliance_requirements" TEXT[],
    "existing_team_summary" TEXT,
    "is_greenfield" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_contexts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "assessment_id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "storage_path" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "upload_type" "DocumentType" NOT NULL,
    "processing_status" "ProcessingStatus" NOT NULL DEFAULT 'PENDING',
    "extracted_text" TEXT,
    "extracted_summary" TEXT,
    "uploaded_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagrams" (
    "id" TEXT NOT NULL,
    "assessment_id" TEXT NOT NULL,
    "document_id" TEXT,
    "deliverable_id" TEXT,
    "direction" "DiagramDirection" NOT NULL DEFAULT 'INGESTED',
    "diagram_format" "DiagramFormat" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "source_code" TEXT,
    "image_storage_path" TEXT,
    "svg_content" TEXT,
    "extracted_entities" JSONB,
    "extracted_summary" TEXT,
    "diagram_type" "DiagramContentType",
    "processing_status" "ProcessingStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "diagrams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidences" (
    "id" TEXT NOT NULL,
    "assessment_id" TEXT NOT NULL,
    "source_type" "EvidenceSourceType" NOT NULL,
    "document_id" TEXT,
    "answer_id" TEXT,
    "content" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_sources" (
    "id" TEXT NOT NULL,
    "assessment_id" TEXT NOT NULL,
    "source_type" "ConnectorType" NOT NULL,
    "connection_status" "ConnectionStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "connection_config" JSONB,
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artifact_validations" (
    "id" TEXT NOT NULL,
    "assessment_id" TEXT NOT NULL,
    "evidence_source_id" TEXT NOT NULL,
    "claim_text" TEXT NOT NULL,
    "artifact_finding" TEXT NOT NULL,
    "status" "ValidationStatus" NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifact_validations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questions" (
    "id" TEXT NOT NULL,
    "assessment_id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "question_text" TEXT NOT NULL,
    "question_type" "QuestionType" NOT NULL,
    "options" JSONB,
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "depends_on" TEXT[],
    "is_answered" BOOLEAN NOT NULL DEFAULT false,
    "generated_by" "GeneratedBy" NOT NULL DEFAULT 'AI',
    "rationale" TEXT,
    "stage" "QuestionStage" NOT NULL DEFAULT 'INTAKE',
    "order_index" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "answers" (
    "id" TEXT NOT NULL,
    "question_id" TEXT NOT NULL,
    "answer_text" TEXT,
    "answer_data" JSONB,
    "answered_by_id" TEXT NOT NULL,
    "confidence_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_scores" (
    "id" TEXT NOT NULL,
    "assessment_id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "maturity_level" "MaturityLevel" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "scoring_rationale" TEXT,
    "review_status" "ReviewStatus" NOT NULL DEFAULT 'DRAFT',
    "reviewed_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "domain_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "findings" (
    "id" TEXT NOT NULL,
    "assessment_id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "finding_type" "FindingType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "evidence_ids" TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "severity" "Severity" NOT NULL DEFAULT 'MEDIUM',
    "review_status" "ReviewStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risks" (
    "id" TEXT NOT NULL,
    "assessment_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "evidence_ids" TEXT[],
    "impact" "Severity" NOT NULL,
    "likelihood" "Likelihood" NOT NULL,
    "severity" "Severity" NOT NULL,
    "mitigation_proposal" TEXT,
    "owner_suggestion" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "review_status" "ReviewStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "risks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendations" (
    "id" TEXT NOT NULL,
    "assessment_id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "effort_indication" TEXT,
    "evidence_ids" TEXT[],
    "related_risk_ids" TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "review_status" "ReviewStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assumptions" (
    "id" TEXT NOT NULL,
    "assessment_id" TEXT NOT NULL,
    "assumption_text" TEXT NOT NULL,
    "impact_if_wrong" TEXT,
    "source" "AssumptionSource" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "requires_validation" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assumptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_proposals" (
    "id" TEXT NOT NULL,
    "assessment_id" TEXT NOT NULL,
    "role_name" TEXT NOT NULL,
    "seniority" "Seniority" NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "justification" TEXT NOT NULL,
    "responsibilities" TEXT NOT NULL,
    "phase" TEXT,
    "expertise_required" TEXT[],
    "review_status" "ReviewStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "estimates" (
    "id" TEXT NOT NULL,
    "assessment_id" TEXT NOT NULL,
    "scenario_name" TEXT NOT NULL,
    "total_effort_hours_low" INTEGER NOT NULL,
    "total_effort_hours_high" INTEGER NOT NULL,
    "total_cost_low" DECIMAL(12,2) NOT NULL,
    "total_cost_high" DECIMAL(12,2) NOT NULL,
    "rate_card_id" TEXT NOT NULL,
    "role_allocations" JSONB NOT NULL,
    "assumptions" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "review_status" "ReviewStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "estimates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_cards" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "rates" JSONB NOT NULL,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3),
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliverables" (
    "id" TEXT NOT NULL,
    "assessment_id" TEXT NOT NULL,
    "deliverable_type" "DeliverableType" NOT NULL,
    "template_id" TEXT,
    "status" "DeliverableStatus" NOT NULL DEFAULT 'GENERATING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deliverables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliverable_sections" (
    "id" TEXT NOT NULL,
    "deliverable_id" TEXT NOT NULL,
    "section_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "order_index" INTEGER NOT NULL,
    "content_draft" TEXT,
    "content_final" TEXT,
    "evidence_ids" TEXT[],
    "review_status" "ReviewStatus" NOT NULL DEFAULT 'DRAFT',
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deliverable_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "deliverable_section_id" TEXT NOT NULL,
    "reviewer_id" TEXT NOT NULL,
    "action" "ReviewAction" NOT NULL,
    "comments" TEXT,
    "content_before" TEXT,
    "content_after" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_artifacts" (
    "id" TEXT NOT NULL,
    "artifact_type" "KnowledgeArtifactType" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "domain" TEXT,
    "tags" TEXT[],
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_strategy_assessments" (
    "id" TEXT NOT NULL,
    "assessment_id" TEXT NOT NULL,
    "team_topology" JSONB,
    "release_model" TEXT,
    "deployment_strategy" TEXT,
    "branching_strategy" TEXT,
    "environment_promotion" TEXT,
    "maturity_score" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_strategy_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_strategy_assessments" (
    "id" TEXT NOT NULL,
    "assessment_id" TEXT NOT NULL,
    "testing_model" TEXT,
    "automation_maturity" TEXT,
    "coverage_visibility" TEXT,
    "ci_cd_test_gates" TEXT,
    "maturity_score" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "test_strategy_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_distribution_assessments" (
    "id" TEXT NOT NULL,
    "assessment_id" TEXT NOT NULL,
    "integration_styles" TEXT[],
    "sync_model" TEXT,
    "event_patterns" TEXT,
    "consistency_model" TEXT,
    "maturity_score" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_distribution_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_assessments" (
    "id" TEXT NOT NULL,
    "assessment_id" TEXT NOT NULL,
    "datastore_types" JSONB,
    "ownership_model" TEXT,
    "transactional_boundaries" TEXT,
    "migration_complexity" TEXT,
    "maturity_score" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storage_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "infrastructure_maturity_assessments" (
    "id" TEXT NOT NULL,
    "assessment_id" TEXT NOT NULL,
    "iac_maturity" TEXT,
    "standardization_level" TEXT,
    "environment_provisioning" TEXT,
    "platform_engineering_maturity" TEXT,
    "maturity_score" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "infrastructure_maturity_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "engagement_members_engagement_id_user_id_key" ON "engagement_members"("engagement_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_types_name_key" ON "assessment_types"("name");

-- CreateIndex
CREATE UNIQUE INDEX "project_contexts_assessment_id_key" ON "project_contexts"("assessment_id");

-- CreateIndex
CREATE UNIQUE INDEX "domain_scores_assessment_id_domain_key" ON "domain_scores"("assessment_id", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "deliverable_sections_deliverable_id_section_key_key" ON "deliverable_sections"("deliverable_id", "section_key");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_strategy_assessments_assessment_id_key" ON "delivery_strategy_assessments"("assessment_id");

-- CreateIndex
CREATE UNIQUE INDEX "test_strategy_assessments_assessment_id_key" ON "test_strategy_assessments"("assessment_id");

-- CreateIndex
CREATE UNIQUE INDEX "data_distribution_assessments_assessment_id_key" ON "data_distribution_assessments"("assessment_id");

-- CreateIndex
CREATE UNIQUE INDEX "storage_assessments_assessment_id_key" ON "storage_assessments"("assessment_id");

-- CreateIndex
CREATE UNIQUE INDEX "infrastructure_maturity_assessments_assessment_id_key" ON "infrastructure_maturity_assessments"("assessment_id");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "engagement_members" ADD CONSTRAINT "engagement_members_engagement_id_fkey" FOREIGN KEY ("engagement_id") REFERENCES "engagements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_members" ADD CONSTRAINT "engagement_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_engagement_id_fkey" FOREIGN KEY ("engagement_id") REFERENCES "engagements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_assessment_type_id_fkey" FOREIGN KEY ("assessment_type_id") REFERENCES "assessment_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_contexts" ADD CONSTRAINT "project_contexts_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagrams" ADD CONSTRAINT "diagrams_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagrams" ADD CONSTRAINT "diagrams_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagrams" ADD CONSTRAINT "diagrams_deliverable_id_fkey" FOREIGN KEY ("deliverable_id") REFERENCES "deliverables"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidences" ADD CONSTRAINT "evidences_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidences" ADD CONSTRAINT "evidences_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidences" ADD CONSTRAINT "evidences_answer_id_fkey" FOREIGN KEY ("answer_id") REFERENCES "answers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_sources" ADD CONSTRAINT "evidence_sources_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_validations" ADD CONSTRAINT "artifact_validations_evidence_source_id_fkey" FOREIGN KEY ("evidence_source_id") REFERENCES "evidence_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answers" ADD CONSTRAINT "answers_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answers" ADD CONSTRAINT "answers_answered_by_id_fkey" FOREIGN KEY ("answered_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_scores" ADD CONSTRAINT "domain_scores_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risks" ADD CONSTRAINT "risks_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assumptions" ADD CONSTRAINT "assumptions_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_proposals" ADD CONSTRAINT "role_proposals_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_rate_card_id_fkey" FOREIGN KEY ("rate_card_id") REFERENCES "rate_cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliverable_sections" ADD CONSTRAINT "deliverable_sections_deliverable_id_fkey" FOREIGN KEY ("deliverable_id") REFERENCES "deliverables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_deliverable_section_id_fkey" FOREIGN KEY ("deliverable_section_id") REFERENCES "deliverable_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_strategy_assessments" ADD CONSTRAINT "delivery_strategy_assessments_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_strategy_assessments" ADD CONSTRAINT "test_strategy_assessments_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_distribution_assessments" ADD CONSTRAINT "data_distribution_assessments_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_assessments" ADD CONSTRAINT "storage_assessments_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infrastructure_maturity_assessments" ADD CONSTRAINT "infrastructure_maturity_assessments_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
