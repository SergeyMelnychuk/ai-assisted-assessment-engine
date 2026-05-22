# AI-Powered Assessment Co-Pilot — Product Design Document

> **Status:** Canonical product spec. Sections A–K, P (product
> definition, modules, domain model, AI design, knowledge model, UX,
> assessment modes, evidence-validation intent, diagrams, expanded
> domains, greenfield workflow, risks) describe the design intent and
> remain a useful reference. Sections L–O (MVP scope, technical
> implementation, repo structure, delivery roadmap) are partly
> historical — the items they list have largely shipped, with some
> deviations called out below.
>
> **Sources of truth for the current implementation:**
> - **Architecture / runtime:** `docs/architecture/README.md`.
> - **Non-obvious decisions:** `docs/architecture/decisions/` (ADRs
>   0001–0028, immutable once accepted).
> - **Data model:** `apps/web/prisma/schema.prisma` (the ERD in §C
>   below is conceptual; the schema has additional tables for the
>   agent harness, templates, audit/log, workflow status, and
>   credential vault that landed in Phases 3–4).
> - **Phase notes:** `docs/design/phase-3-retrospective.md` (Phase 3
>   shipped in full) and `docs/design/phase-4-agentic-ai.md` (Phase 4
>   in flight; the slice plan there has been deviated from — see its
>   "Phase 4 work that landed outside the original slice plan"
>   section).
>
> Notable deltas from this document:
>
> - **Evidence connectors are shipped, not MVP+1.** GitHub repository
>   linking (ADR-0009 / 0010 / 0022) and the agent harness (ADR-0014
>   / 0017 / 0021 / 0026) cover the §B "Evidence Connector (MVP+1)"
>   row.
> - **Multi-provider LLM routing** (ADR-0015) replaced the single
>   "Claude API" entry in §M. All AI calls go through
>   `services/ai/router.ts`.
> - **Hybrid retrieval** (ADR-0027) added a Postgres `tsvector`
>   lexical stage fused with cosine via Reciprocal Rank Fusion, behind
>   a feature flag. Not anticipated in this document.
> - **Evidence citations + context popup** (ADR-0028) added a single
>   citation surface used across reviewer pages. Not anticipated here.
> - **MVP+1 items still outstanding:** PPTX export, multi-tenant,
>   Playwright E2E, sandbox-policy ADR (was reserved as ADR-0018, that
>   number was reassigned to customer-uploadable templates).

## A. Product Definition

### Concise Description

The Assessment Co-Pilot is an AI-powered platform that standardizes, accelerates, and partially automates early-stage consulting activities — discovery, architecture assessment, audit preparation, modernization review, solution shaping, and estimation. It guides consultants through structured intake, analyzes documents and technical artifacts, applies reusable assessment frameworks, drafts deliverables, and surfaces findings for expert review and approval.

### Target Users

| Role | Primary Use |
|------|-------------|
| **Architect** | Run assessments, review findings, approve architecture recommendations |
| **Consultant** | Conduct intake, gather information, draft reports |
| **Business Analyst** | Manage structured intake, document business context |
| **Security Expert** | Review security/IAM findings, validate security posture |
| **Delivery Lead** | Validate team composition, estimates, delivery strategy |
| **Pre-Sales / Sales** | Quick ROM estimates, proposal drafts for opportunities |
| **Reviewer / Approver** | Review and approve AI-drafted deliverables |
| **Knowledge Manager / Admin** | Maintain templates, checklists, rate cards, frameworks |

### Main Use Cases

1. **Architecture Assessment** — Evaluate an existing system's architecture, identify risks, gaps, and recommendations
2. **Discovery Before Implementation** — Structured information gathering before a new project starts
3. **Modernization Assessment** — Assess readiness and risks for migration/transformation
4. **Audit / Readiness Review** — Structured readiness check before scale-up, compliance, or operational hardening
5. **Solution Shaping** — Define scope, architecture direction, team, and estimate before implementation
6. **Greenfield / Startup Discovery** — Shape a new product from scratch — capabilities, tech stack, MVP, roadmap

### Core Value Proposition

Reduce expert effort on repetitive assessment phases by 60-75% while improving consistency, traceability, and deliverable quality. AI handles structured intake, analysis support, and draft generation. Experts focus on judgment, validation, and approval.

### Boundaries and Non-Goals

- **Not** a fully autonomous architecture consultant
- **Not** a black-box estimation engine — all estimates are explainable
- **Not** a compliance authority or penetration testing tool
- **Not** a replacement for accountable experts
- **Not** a generic chatbot — all interactions follow structured methodology
- **Not** an unrestricted scanner — all access to client systems requires explicit approval

---

## B. Functional Architecture

### Major Modules

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Frontend (Web App)                           │
│  Engagement Dashboard │ Intake UI │ Q&A │ Review │ Export │ Admin  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ REST / WebSocket
┌──────────────────────────────┴──────────────────────────────────────┐
│                         API Gateway / BFF                           │
│              Auth │ RBAC │ Rate Limiting │ Audit Log                │
└──────────┬───────┬───────┬───────┬───────┬───────┬─────────────────┘
           │       │       │       │       │       │
     ┌─────┴──┐ ┌──┴───┐ ┌┴────┐ ┌┴────┐ ┌┴────┐ ┌┴──────────────┐
     │Engage- │ │Intake│ │Ques-│ │Anal-│ │Deli-│ │  Knowledge    │
     │ment    │ │& Doc │ │tion │ │ysis │ │ver- │ │  Base Service │
     │Service │ │Proc. │ │Eng. │ │Eng. │ │able │ │               │
     └────────┘ └──────┘ └─────┘ └─────┘ └─────┘ └───────────────┘
           │       │       │       │       │       │
     ┌─────┴───────┴───────┴───────┴───────┴───────┴─────────────────┐
     │                    Core Domain Services                        │
     │  Assessment Orchestrator │ Scoring │ Estimation │ Review Mgmt  │
     └───────────────────────────┬────────────────────────────────────┘
                                 │
     ┌───────────────────────────┴────────────────────────────────────┐
     │                    Infrastructure Layer                        │
     │  PostgreSQL │ Blob Storage │ Vector Store │ Task Queue │ LLM   │
     └────────────────────────────────────────────────────────────────┘
```

### Module Responsibilities

| Module | Responsibility |
|--------|---------------|
| **Engagement Service** | Create/manage engagements, configure assessment type and mode, manage lifecycle states |
| **Intake & Document Processing** | Upload, parse, chunk, and extract structured data from documents (PDF, DOCX, diagrams, API specs, etc.) |
| **Question Engine** | Generate adaptive questions based on assessment type, mode, domain, and prior answers. Detect missing info. |
| **Analysis Engine** | Apply frameworks, score domains, generate findings/risks/recommendations, map evidence to conclusions |
| **Deliverable Engine** | Assemble structured outputs using templates, approved content blocks, and AI-generated drafts |
| **Knowledge Base Service** | CRUD for frameworks, checklists, templates, heuristics, risk/recommendation patterns, rate cards, role catalogs |
| **Assessment Orchestrator** | Manage the stage-by-stage workflow. Track what's complete, what's pending, what needs expert input |
| **Scoring Service** | Apply configurable maturity/scoring models per domain |
| **Estimation Service** | Calculate effort, team composition, pricing based on rules, heuristics, and assessment results |
| **Review Management** | Track draft/review/approved status per deliverable section. Support edit, override, approve workflows |
| **Diagram Service** | Parse uploaded architecture diagrams (Structurizr, Mermaid, PlantUML, WebSequenceDiagrams, PNG/SVG/JPEG) into structured entities. Generate diagrams as deliverable outputs. Render text-based diagrams to images |
| **Evidence Connector** | (Shipped, originally scoped MVP+1.) GitHub repository ingest via the tarball API (ADR-0009 / 0010 / 0022) + agent harness for autonomous read-only collection (ADR-0014 / 0017). IaC / cloud-config / CI/CD ingestion remain MVP+2. |
| **Export Service** | Render deliverables to DOCX, PDF, PPTX — including embedded diagrams |
| **Auth & RBAC** | Authentication, role-based access, engagement-level permissions |
| **Audit Trail** | Record all significant actions: inputs, questions, answers, AI outputs, human edits, approvals |

### Key Workflows

1. **Engagement Creation** → Setup → Intake → Questioning → Analysis → Drafting → Review → Export
2. **Knowledge Management** → CRUD templates, frameworks, rate cards → Version → Publish
3. **Evidence Validation** (MVP+1) → Request access → Ingest artifacts → Analyze → Validate claims → Flag contradictions
4. **Diagram Ingestion** → Upload diagram → Detect format → Parse/extract entities → AI summarization → Store as evidence
5. **Diagram Generation** → Analysis results → Select diagram type → Generate source code (Mermaid/PlantUML) → Render to image → Embed in deliverable

### Integration Points

- **LLM provider(s)** — primary Anthropic Claude; multi-provider router (ADR-0015) supports OpenAI / Bedrock / Mistral as per-task fallbacks. Embedding provider is OpenAI (`text-embedding-3-small`, ADR-0003).
- **Blob Storage** — uploaded documents, diagram images, generated exports
- **Vector Store** — knowledge base retrieval, document chunk search
- **Export Rendering** — DOCX/PDF generation with embedded diagrams
- **Diagram Renderers** — Mermaid CLI, PlantUML server, Structurizr CLI/Lite for rendering text-based diagrams to images
- **Evidence Connectors** — GitHub (shipped via tarball API + agent harness). GitLab, Terraform Cloud, cloud provider APIs, Kubernetes API, CI/CD systems still pending.

### Knowledge Base Strategy

The knowledge base is a structured, versioned collection of assessment artifacts stored in the database with vector embeddings for retrieval. It is maintained by Knowledge Managers through an admin UI and consumed by the AI components via semantic search and direct lookup.

### Orchestration Approach

A state-machine per engagement tracks progression through assessment stages. Each stage has entry/exit conditions, required completions, and optional expert checkpoints. The orchestrator drives the workflow but never blocks — users can navigate non-linearly.

### Human Review Flow

```
AI Draft → Pending Review → Expert Opens → Edit/Accept/Reject per section
                                          → Override AI suggestion
                                          → Add notes
                                          → Approve
                                          → Request more analysis
```

Every deliverable section tracks: `draft | in_review | approved | rejected | needs_revision`

---

## C. Domain Model

### Entity Relationship Diagram (Text)

```
Engagement 1──* Assessment
Assessment *──1 AssessmentType
Assessment *──1 AssessmentMode
Assessment 1──1 ProjectContext
Assessment 1──* Document
Assessment 1──* Evidence
Assessment 1──* EvidenceSource
Assessment 1──* Question
Question   1──* Answer
Assessment 1──* DomainScore
Assessment 1──* Finding
Assessment 1──* Risk
Assessment 1──* Recommendation
Assessment 1──* Assumption
Assessment 1──* RoleProposal
Assessment 1──* Estimate
Estimate   *──1 RateCard
Assessment 1──* Deliverable
Deliverable 1──* DeliverableSection
DeliverableSection 1──* Review
Review     1──0..1 Approval

KnowledgeArtifact ──> Template
KnowledgeArtifact ──> HeuristicRule
KnowledgeArtifact ──> RiskPattern
KnowledgeArtifact ──> RecommendationPattern
KnowledgeArtifact ──> TechnologyOption
KnowledgeArtifact ──> PlatformRecommendation
KnowledgeArtifact ──> CapabilityMap

Assessment 1──0..1 DeliveryStrategyAssessment
Assessment 1──0..1 TestStrategyAssessment
Assessment 1──0..1 DataDistributionAssessment
Assessment 1──0..1 StorageAssessment
Assessment 1──0..1 InfrastructureMaturityAssessment
```

### Core Entity Definitions

```
Engagement {
  id: UUID
  name: string
  client_name: string
  industry: string
  created_by: UserId
  created_at: timestamp
  status: draft | active | completed | archived
  members: EngagementMember[]
}

Assessment {
  id: UUID
  engagement_id: UUID
  assessment_type_id: UUID
  assessment_mode: existing_system | greenfield | modernization | audit | pre_implementation
  status: setup | intake | questioning | analysis | drafting | review | completed
  project_context_id: UUID
  created_at: timestamp
  updated_at: timestamp
  overall_confidence: float  // 0.0 - 1.0
}

AssessmentType {
  id: UUID
  name: string               // "Architecture Assessment", "Discovery", etc.
  description: string
  default_domains: string[]   // which domains to activate by default
  default_mode: AssessmentMode
  template_id: UUID
  is_active: boolean
}

ProjectContext {
  id: UUID
  assessment_id: UUID
  project_name: string
  description: text
  industry: string
  cloud_providers: string[]
  platforms: string[]
  known_constraints: text
  business_goals: text
  expected_timeline: string
  budget_sensitivity: low | medium | high
  target_delivery_model: string
  estimated_users: string
  compliance_requirements: string[]
  existing_team_summary: text
  is_greenfield: boolean
}

Document {
  id: UUID
  assessment_id: UUID
  filename: string
  mime_type: string
  storage_path: string
  upload_type: rfp | architecture_doc | nfr_doc | backlog | api_spec |
               diagram_structurizr | diagram_mermaid | diagram_plantuml |
               diagram_websequence | diagram_image | diagram_svg | diagram_other |
               meeting_notes | incident_summary | security_doc | other
  processing_status: pending | processing | processed | failed
  extracted_summary: text
  uploaded_by: UserId
  uploaded_at: timestamp
}

Diagram {
  id: UUID
  assessment_id: UUID
  document_id: UUID?            // set when ingested from an uploaded document
  deliverable_id: UUID?         // set when generated as part of a deliverable
  direction: ingested | generated
  diagram_format: structurizr | mermaid | plantuml | websequencediagrams | png | svg | jpeg | draw_io | other
  title: string
  description: text
  source_code: text             // text-based source (Mermaid, PlantUML, Structurizr DSL, WSD)
  image_storage_path: string    // S3 path for rendered image or uploaded raster
  svg_content: text             // inline SVG when available
  extracted_entities: jsonb     // {components, services, connections, layers, databases, queues, ...}
  extracted_summary: text       // AI-generated natural-language description
  diagram_type: system_context | container | component | deployment | sequence |
                data_flow | network_topology | er_diagram | state_machine |
                activity_flow | infrastructure | other
  processing_status: pending | processing | processed | failed
}

Evidence {
  id: UUID
  assessment_id: UUID
  source_type: document | answer | artifact | connector
  source_id: UUID
  content: text
  domain: string
  confidence: float
  extracted_at: timestamp
}

EvidenceSource {
  id: UUID
  assessment_id: UUID
  source_type: repository | iac_repo | cicd | cloud_config | k8s | monitoring |
               test_report | database_schema | backlog | documentation
  connection_status: pending_approval | connected | failed | disconnected
  connection_config: jsonb     // encrypted
  approved_by: UserId
  approved_at: timestamp
}

Question {
  id: UUID
  assessment_id: UUID
  domain: string
  question_text: text
  question_type: single_choice | multi_choice | free_text | numeric | file_upload | confirmation
  options: jsonb               // for choice questions
  priority: critical | high | medium | low
  depends_on: UUID[]           // previous questions/answers
  is_answered: boolean
  generated_by: ai | template | manual
  rationale: text              // why this question matters
  stage: intake | follow_up | clarification | evidence_request
}

Answer {
  id: UUID
  question_id: UUID
  answer_text: text
  answer_data: jsonb
  answered_by: UserId
  answered_at: timestamp
  attachments: UUID[]          // Document IDs
  confidence_note: text        // "not sure", "approximate", etc.
}

DomainScore {
  id: UUID
  assessment_id: UUID
  domain: string               // e.g. "architecture", "security", "devops"
  score: float                 // 0-5 or 0-100 depending on model
  maturity_level: ad_hoc | initial | defined | managed | optimized
  confidence: float
  evidence_ids: UUID[]
  scoring_rationale: text
  reviewed_by: UserId
  review_status: draft | reviewed | approved
}

Finding {
  id: UUID
  assessment_id: UUID
  domain: string
  finding_type: strength | weakness | gap | observation | opportunity
  title: string
  description: text
  evidence_ids: UUID[]
  confidence: float
  severity: critical | high | medium | low | info
  review_status: draft | reviewed | approved | rejected
}

Risk {
  id: UUID
  assessment_id: UUID
  title: string
  category: string
  description: text
  evidence_ids: UUID[]
  impact: critical | high | medium | low
  likelihood: very_likely | likely | possible | unlikely
  severity: critical | high | medium | low
  mitigation_proposal: text
  owner_suggestion: string
  confidence: float
  review_status: draft | reviewed | approved | rejected
}

Recommendation {
  id: UUID
  assessment_id: UUID
  domain: string
  title: string
  description: text
  priority: critical | high | medium | low
  effort_indication: string
  evidence_ids: UUID[]
  related_risk_ids: UUID[]
  confidence: float
  review_status: draft | reviewed | approved | rejected
}

Assumption {
  id: UUID
  assessment_id: UUID
  assumption_text: text
  impact_if_wrong: text
  source: ai_inferred | stakeholder_stated | evidence_based
  confidence: float
  requires_validation: boolean
}

RoleProposal {
  id: UUID
  assessment_id: UUID
  role_name: string
  seniority: junior | mid | senior | lead | principal
  count: int
  justification: text
  responsibilities: text
  phase: string                // "Phase 1", "Ongoing", etc.
  expertise_required: string[]
  review_status: draft | reviewed | approved
}

Estimate {
  id: UUID
  assessment_id: UUID
  scenario_name: string        // "Conservative", "Recommended", "Aggressive"
  total_effort_hours_low: int
  total_effort_hours_high: int
  total_cost_low: decimal
  total_cost_high: decimal
  rate_card_id: UUID
  role_allocations: jsonb      // [{role, hours_low, hours_high, rate}]
  assumptions: text
  confidence: float
  review_status: draft | reviewed | approved
}

RateCard {
  id: UUID
  name: string
  currency: string
  rates: jsonb                 // [{role, seniority, hourly_rate, daily_rate}]
  valid_from: date
  valid_to: date
  is_default: boolean
}

Deliverable {
  id: UUID
  assessment_id: UUID
  deliverable_type: executive_summary | assessment_report | risk_register |
                    target_state | roadmap | team_proposal | estimate |
                    assumptions_gaps | sow_draft | greenfield_discovery
  template_id: UUID
  status: generating | draft | in_review | approved | exported
  created_at: timestamp
}

DeliverableSection {
  id: UUID
  deliverable_id: UUID
  section_key: string
  title: string
  order: int
  content_draft: text          // AI-generated
  content_final: text          // after expert edits
  evidence_ids: UUID[]
  review_status: draft | in_review | approved | rejected | needs_revision
  reviewed_by: UserId
  reviewed_at: timestamp
  edit_history: jsonb
}

Review {
  id: UUID
  deliverable_section_id: UUID
  reviewer_id: UserId
  action: approve | reject | edit | request_revision
  comments: text
  created_at: timestamp
}

Approval {
  id: UUID
  review_id: UUID
  approved_by: UserId
  approved_at: timestamp
}

KnowledgeArtifact {
  id: UUID
  artifact_type: framework | checklist | template | heuristic | risk_pattern |
                 recommendation_pattern | role_catalog | rate_card |
                 technology_option | platform_guidance | capability_model |
                 scoring_model | industry_overlay | cloud_overlay
  name: string
  description: text
  content: jsonb
  version: int
  is_active: boolean
  domain: string
  tags: string[]
  created_by: UserId
  updated_at: timestamp
}

Template {
  id: UUID
  knowledge_artifact_id: UUID
  template_type: deliverable | question_set | checklist | scoring_rubric
  structure: jsonb             // section definitions, placeholders
  format: markdown | docx_template | pptx_template
}

HeuristicRule {
  id: UUID
  knowledge_artifact_id: UUID
  rule_type: scoring | estimation | staffing | risk_detection | recommendation
  condition: jsonb             // when to apply
  action: jsonb                // what to conclude
  confidence_weight: float
  domain: string
}

TechnologyOption {
  id: UUID
  knowledge_artifact_id: UUID
  category: string             // "database", "messaging", "frontend", etc.
  name: string
  description: text
  pros: text[]
  cons: text[]
  best_for: text[]
  avoid_when: text[]
  maturity: emerging | established | legacy
}

PlatformRecommendation {
  id: UUID
  knowledge_artifact_id: UUID
  platform: string
  use_case: text
  guidance: text
  prerequisites: text[]
}

CapabilityMap {
  id: UUID
  knowledge_artifact_id: UUID
  capability_name: string
  description: text
  sub_capabilities: jsonb
  typical_components: string[]
  assessment_questions: string[]
}

// Specialized domain assessments (extend base assessment)

DeliveryStrategyAssessment {
  id: UUID
  assessment_id: UUID
  team_topology: jsonb
  release_model: text
  deployment_strategy: text
  branching_strategy: text
  environment_promotion: text
  findings: UUID[]             // Finding IDs
  maturity_score: float
}

TestStrategyAssessment {
  id: UUID
  assessment_id: UUID
  testing_model: text
  automation_maturity: text
  coverage_visibility: text
  ci_cd_test_gates: text
  findings: UUID[]
  maturity_score: float
}

DataDistributionAssessment {
  id: UUID
  assessment_id: UUID
  integration_styles: text[]
  sync_model: text
  event_patterns: text
  consistency_model: text
  findings: UUID[]
  maturity_score: float
}

StorageAssessment {
  id: UUID
  assessment_id: UUID
  datastore_types: jsonb
  ownership_model: text
  transactional_boundaries: text
  migration_complexity: text
  findings: UUID[]
  maturity_score: float
}

InfrastructureMaturityAssessment {
  id: UUID
  assessment_id: UUID
  iac_maturity: text
  standardization_level: ad_hoc | partial | mature
  environment_provisioning: text
  platform_engineering_maturity: text
  findings: UUID[]
  maturity_score: float
}

ArtifactValidation {
  id: UUID
  assessment_id: UUID
  evidence_source_id: UUID
  claim_text: text             // what stakeholder said
  artifact_finding: text       // what the artifact shows
  status: confirmed | contradicted | partially_confirmed | inconclusive
  notes: text
}
```

---

## D. Data Flow

```
┌──────────────────────┐
│  1. INTAKE           │
│  Documents, metadata,│
│  initial answers     │
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  2. EXTRACTION       │
│  Parse documents     │
│  Extract structured  │
│  signals & evidence  │
│  Chunk & embed       │
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  3. ASSESSMENT STATE │
│  Build structured    │
│  view per domain     │
│  Identify gaps       │
│  Generate questions  │
└──────────┬───────────┘
           ▼
┌──────────────────────┐       ┌──────────────────────┐
│  4. INTERACTIVE Q&A  │◀─────▶│  4b. EVIDENCE        │
│  Adaptive questions  │       │  VALIDATION          │
│  Collect answers     │       │  Request artifacts   │
│  Refine state        │       │  Analyze repos/infra │
│  Loop until ready    │       │  Validate claims     │
└──────────┬───────────┘       └──────────┬───────────┘
           ▼                              │
┌──────────────────────────────────────────┘
│  5. ANALYSIS
│  Apply frameworks & heuristics
│  Score domains
│  Generate findings, risks, recommendations
│  Flag low-confidence areas
│  Distinguish fact / inference / assumption
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  6. SOLUTION SHAPING │
│  Propose target state│
│  Define workstreams  │
│  Team composition    │
│  Effort estimation   │
│  Pricing calculation │
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  7. DRAFT GENERATION │
│  Assemble deliverable│
│  sections from       │
│  templates + AI      │
│  drafts              │
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  8. EXPERT REVIEW    │
│  Review per section  │
│  Edit / Approve /    │
│  Reject / Override   │
│  Track provenance    │
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  9. EXPORT           │
│  DOCX / PDF / PPTX   │
│  with branding       │
└──────────────────────┘
```

---

## E. AI Design

### Where LLMs Are Used

| Capability | LLM Role | Deterministic Fallback |
|-----------|----------|----------------------|
| **Document parsing & summarization** | Extract structured data from unstructured docs | Metadata extraction for known formats |
| **Question generation** | Generate follow-up questions adapted to context | Template-based question sets as baseline |
| **Answer interpretation** | Understand free-text answers, extract facts | Structured answer types (choice, numeric) |
| **Finding generation** | Synthesize findings from evidence + knowledge base | Rule-based pattern matching for known patterns |
| **Risk identification** | Identify risks from project context and evidence | Risk pattern library matching |
| **Recommendation drafting** | Draft actionable recommendations | Template-based recommendations from patterns |
| **Deliverable section writing** | Draft report sections, executive summaries | Template fill with structured data |
| **Confidence assessment** | Evaluate evidence strength and coverage | Rule-based confidence from data completeness |
| **Contradiction detection** | Compare stakeholder claims vs evidence | Exact-match validation rules |

### Where Deterministic Rules Are Preferred

- **Scoring models** — configured rubrics with weighted criteria, not LLM judgment
- **Pricing calculation** — rate card × effort = price, with clear formula
- **Workflow state transitions** — state machine, not AI decision
- **Access control** — RBAC rules, not AI gating
- **Template structure** — defined sections and ordering
- **Effort range calculation** — heuristic formulas with configurable parameters
- **Data validation** — schema validation for structured inputs

### Prompting Strategy

1. **System prompts** per capability (question generation, finding generation, etc.) — stored as versioned knowledge artifacts
2. **Context injection** — include relevant project context, prior answers, domain-specific knowledge base excerpts retrieved via vector search
3. **Structured output** — request JSON-structured responses from the LLM, validate against schemas
4. **Chain of thought** — for complex analysis, use multi-step reasoning with intermediate validation
5. **Few-shot examples** — include sample outputs from knowledge base for consistency

### Knowledge Base Retrieval

1. **Direct lookup** — for templates, checklists, rate cards (structured, keyed by type/domain)
2. **Vector search** — for finding relevant risk patterns, recommendations, technology guidance based on project context
3. **Hybrid** — combine structured filtering (by domain, assessment type) with semantic search for ranking

### Confidence Handling

Every AI-generated output includes:
- `confidence: float` (0.0–1.0)
- `evidence_basis: enum` — `explicit_fact | inferred | assumed | heuristic | missing_data`
- `evidence_ids: UUID[]` — what evidence supports this

Confidence thresholds:
- **> 0.8** — high confidence, presented as finding
- **0.5–0.8** — moderate confidence, flagged for review
- **< 0.5** — low confidence, marked as assumption requiring validation

### Expert Review Checkpoints

Mandatory review gates:
1. After domain scoring — before generating recommendations
2. After risk register generation — before team/estimation
3. After estimation — before deliverable generation
4. Before export — all sections must be approved

Optional review gates (configurable):
- After initial intake summary
- After each domain analysis
- After target-state proposal

---

## F. Knowledge Model

### Structure

```
knowledge_base/
├── frameworks/
│   ├── architecture_assessment_v1.json
│   ├── discovery_framework_v1.json
│   ├── modernization_framework_v1.json
│   └── audit_readiness_v1.json
├── checklists/
│   ├── security_iam_checklist.json
│   ├── cloud_readiness_checklist.json
│   ├── devops_maturity_checklist.json
│   └── api_integration_checklist.json
├── scoring_models/
│   ├── domain_maturity_5level.json
│   └── risk_severity_matrix.json
├── question_templates/
│   ├── business_context_questions.json
│   ├── architecture_questions.json
│   ├── security_questions.json
│   └── nfr_questions.json
├── risk_patterns/
│   ├── common_architecture_risks.json
│   ├── migration_risks.json
│   └── delivery_risks.json
├── recommendation_patterns/
│   ├── architecture_recommendations.json
│   ├── devops_recommendations.json
│   └── security_recommendations.json
├── role_catalog/
│   └── standard_roles.json
├── rate_cards/
│   └── default_rate_card.json
├── estimation_heuristics/
│   ├── effort_estimation_rules.json
│   └── staffing_heuristics.json
├── deliverable_templates/
│   ├── executive_summary_template.md
│   ├── assessment_report_template.md
│   ├── risk_register_template.md
│   └── sow_template.md
├── technology_options/
│   ├── databases.json
│   ├── messaging.json
│   ├── frontend_frameworks.json
│   └── cloud_services.json
├── platform_guidance/
│   ├── aws_guidance.json
│   ├── azure_guidance.json
│   └── gcp_guidance.json
├── industry_overlays/
│   ├── fintech.json
│   ├── healthcare.json
│   └── ecommerce.json
└── capability_models/
    ├── web_application.json
    ├── data_platform.json
    └── mobile_application.json
```

### Knowledge Artifact Schema

Every knowledge artifact follows:

```json
{
  "id": "uuid",
  "type": "framework | checklist | scoring_model | ...",
  "name": "Architecture Assessment Framework",
  "version": 3,
  "domain": "architecture",
  "tags": ["assessment", "existing-system"],
  "applicable_to": {
    "assessment_types": ["architecture_assessment"],
    "assessment_modes": ["existing_system", "modernization"],
    "industries": ["*"],
    "platforms": ["*"]
  },
  "content": { /* type-specific content */ },
  "metadata": {
    "created_by": "user-id",
    "created_at": "2026-01-15",
    "updated_at": "2026-03-20",
    "approved": true
  }
}
```

### Risk Pattern Example

```json
{
  "pattern_id": "risk-arch-001",
  "title": "Monolithic architecture scaling limitations",
  "domain": "architecture",
  "trigger_conditions": [
    "architecture_style == 'monolith'",
    "expected_growth > 'moderate'",
    "deployment_frequency_desired > 'weekly'"
  ],
  "risk_template": {
    "title": "Scalability constraints due to monolithic architecture",
    "description": "The current monolithic architecture may not support the expected growth in users/transactions and desired deployment frequency without significant refactoring.",
    "impact": "high",
    "likelihood": "likely",
    "mitigation": "Consider a phased decomposition strategy starting with the highest-traffic or most-changed modules."
  },
  "confidence_base": 0.7,
  "evidence_boost": {
    "repository_analysis_confirms": 0.2,
    "performance_metrics_confirm": 0.1
  }
}
```

### Estimation Heuristic Example

```json
{
  "rule_id": "est-001",
  "name": "Base effort by scope complexity",
  "condition": {
    "scope_complexity": "medium",
    "team_familiarity": "new"
  },
  "base_effort_person_months": { "low": 3, "high": 6 },
  "multipliers": [
    { "factor": "compliance_requirements", "values": { "none": 1.0, "standard": 1.2, "strict": 1.5 }},
    { "factor": "integration_count", "ranges": [
      { "min": 0, "max": 3, "multiplier": 1.0 },
      { "min": 4, "max": 8, "multiplier": 1.3 },
      { "min": 9, "max": 999, "multiplier": 1.6 }
    ]}
  ]
}
```

---

## G. UX / Workflow Design

### User Journey

**Step 1: Create Engagement**
- Name the engagement, select client/industry
- Invite team members, assign roles

**Step 2: Configure Assessment**
- Select assessment type (e.g., "Architecture Assessment")
- Select assessment mode (e.g., "Existing System")
- Define scope — which domains to include
- Set known constraints, timeline expectations

**Step 3: Upload Initial Materials**
- Drag-and-drop documents (RFP, architecture docs, NFRs, etc.)
- Tag each document with its type
- System begins background processing

**Step 4: AI Summarizes Context**
- AI extracts key facts from uploaded materials
- Presents structured summary: what we know, what's missing, initial observations
- Consultant reviews and corrects the summary

**Step 5: Adaptive Questioning**
- AI generates prioritized questions per domain
- Questions are grouped by domain tab, sorted by priority
- As answers come in, AI generates follow-up questions
- UI shows coverage progress per domain (% answered, confidence)

**Step 6: Request More Evidence (if needed)**
- AI flags areas where answers are vague or insufficient
- Suggests specific evidence to request (e.g., "Can you provide the CI/CD pipeline configuration?")
- User uploads additional documents or connects evidence sources

**Step 7: AI Drafts Findings & Deliverables**
- User triggers analysis when ready (or AI suggests readiness)
- AI produces draft: scores, findings, risks, recommendations, team, estimate
- Each item shows confidence level and evidence trail

**Step 8: Expert Review**
- Experts review each section independently
- Per-section status: approve / edit / reject / request revision
- Editors can modify AI text, add notes, override scores
- Dashboard shows review progress

**Step 9: Export**
- Select deliverable format (DOCX, PDF, PPTX)
- Apply branding template
- Download or share

### UI Structure

```
Sidebar:
  ├── Engagement List
  ├── Active Assessment
  │   ├── Overview / Dashboard
  │   ├── Setup
  │   ├── Documents
  │   ├── Questions & Answers
  │   ├── Evidence Sources
  │   ├── Domain Scores
  │   ├── Findings
  │   ├── Risks
  │   ├── Recommendations
  │   ├── Team & Estimate
  │   ├── Deliverables
  │   └── Export
  ├── Knowledge Base (Admin)
  └── Settings
```

---

## H. Assessment Modes

### Existing-System Assessment

- **Intake focus:** Current architecture, tech stack, team structure, pain points, NFRs, existing documentation
- **Question emphasis:** "What exists?", "How does it work?", "What problems have you seen?"
- **Analysis focus:** Gap analysis, maturity scoring, risk identification, modernization opportunities
- **Evidence validation:** Compare stated architecture vs. actual code/infra (MVP+1)
- **Deliverables:** Assessment report, risk register, recommendations, target-state, roadmap, estimate

### Greenfield Discovery

- **Intake focus:** Business vision, target users, product goals, desired capabilities, constraints, timeline
- **Question emphasis:** "What do you need?", "Who are the users?", "What are the priorities?", "What exists vs what must be built?"
- **Analysis focus:** Capability mapping, technology selection, architecture direction, MVP scoping
- **Evidence validation:** Limited — focus on market/domain validation (MVP+1)
- **Deliverables:** Discovery summary, capability map, architecture direction, technology options, MVP scope, phased roadmap, team proposal, ROM estimate

### Key Behavioral Differences

| Aspect | Existing System | Greenfield |
|--------|----------------|------------|
| Starting point | Documents about what exists | Vision of what should exist |
| Primary question | "What's wrong / at risk?" | "What should we build and how?" |
| Scoring | Maturity of existing domains | Readiness / completeness of definition |
| Risks | Technical debt, scalability, gaps | Ambiguity, scope creep, tech selection |
| Target state | Improve/modernize existing | Define from scratch |
| Estimation | Effort to improve/migrate | Effort to build new |

---

## I. Evidence Validation (MVP+1)

### Escalation Flow

```
1. Stakeholder provides answer
   └─ Answer is clear and specific → Accept as evidence
   └─ Answer is vague or uncertain
      └─ Ask clarifying follow-up
         └─ Still insufficient
            └─ Request specific artifact
               (e.g., "Please upload your Terraform files" or
                "Can we connect to the GitHub repository?")
               └─ Artifact provided
                  └─ Analyze artifact
                     └─ Validate or contradict stakeholder claim
                        └─ Record ArtifactValidation
```

### Artifact Analysis Capabilities (by type)

| Artifact Type | What Can Be Extracted |
|--------------|----------------------|
| **Source code repo** | Languages, frameworks, dependencies, test coverage, code structure, complexity |
| **IaC (Terraform/Bicep)** | Infrastructure topology, services used, region, sizing, security groups |
| **CI/CD configs** | Pipeline stages, test gates, deployment targets, automation maturity |
| **K8s manifests** | Service topology, resource limits, health checks, networking |
| **API specs (OpenAPI)** | Endpoint inventory, auth model, data models |
| **DB schemas** | Table structure, relationships, indexes, migration history |
| **Monitoring dashboards** | Metrics collected, alerting rules, SLO definitions |

### Contradiction Handling

When artifact analysis contradicts a stakeholder claim:
1. Record both the claim and the artifact finding
2. Create an `ArtifactValidation` record with status `contradicted`
3. Surface in the review UI as a discrepancy requiring expert resolution
4. Do not silently override — always flag for human decision

---

## I-bis. Architecture Diagram Support (Parse + Generate)

The system supports architecture diagrams as both **inputs** (uploaded for analysis) and **outputs** (generated as part of deliverables).

### Supported Diagram Formats

| Format | Parse (Input) | Generate (Output) | Notes |
|--------|:---:|:---:|-------|
| **Mermaid** | Yes | Yes | Primary generation format — widely supported, renders in markdown, easy for AI to produce |
| **PlantUML** | Yes | Yes | Rich diagram vocabulary, good for sequence and component diagrams |
| **Structurizr DSL** | Yes | Yes (MVP+1) | C4 model native, excellent for system context / container / component views |
| **WebSequenceDiagrams** | Yes | No | Parse only — niche but sometimes provided by clients |
| **Draw.io / diagrams.net** | Yes (MVP+1) | No | XML-based, common in enterprise, parse-only |
| **PNG / JPEG** | Yes | Yes (rendered) | Vision AI for parsing; text-based diagrams rendered to images for export |
| **SVG** | Yes | Yes (rendered) | Can parse both visual content (via AI) and embedded structure |

### Diagram Ingestion Pipeline

```
Upload diagram file
  │
  ├─ Text-based (Mermaid, PlantUML, Structurizr, WSD)?
  │   ├─ Store source code in diagram record
  │   ├─ Parse source → extract entities (components, services, connections, layers)
  │   ├─ Render to image (via CLI tool / server) → store in S3
  │   └─ Call Claude to summarize the diagram in natural language
  │
  ├─ SVG?
  │   ├─ Store SVG content inline
  │   ├─ Check for embedded metadata (if text-based source is embedded)
  │   ├─ Call Claude (vision) to describe and extract entities
  │   └─ Store extracted entities + summary
  │
  └─ Raster image (PNG, JPEG)?
      ├─ Store image in S3
      ├─ Call Claude (vision) to:
      │   ├─ Describe what the diagram shows
      │   ├─ Extract entities (components, services, connections, data flows)
      │   ├─ Classify diagram type (system context, sequence, deployment, etc.)
      │   └─ Flag ambiguous or hard-to-read elements
      └─ Store extracted entities + summary
```

### Entity Extraction

From any diagram, the system attempts to extract structured data:

```json
{
  "diagramType": "container",
  "entities": {
    "components": [
      { "name": "Web App", "type": "frontend", "technology": "React" },
      { "name": "API Gateway", "type": "gateway", "technology": "Kong" },
      { "name": "User Service", "type": "service", "technology": "Java/Spring" }
    ],
    "connections": [
      { "from": "Web App", "to": "API Gateway", "protocol": "HTTPS", "description": "REST API calls" },
      { "from": "API Gateway", "to": "User Service", "protocol": "HTTP", "description": "Routes /users/*" }
    ],
    "datastores": [
      { "name": "User DB", "type": "PostgreSQL", "connectedTo": ["User Service"] }
    ],
    "externalSystems": [
      { "name": "Auth0", "type": "identity_provider", "connectedTo": ["API Gateway"] }
    ],
    "boundaries": [
      { "name": "Cloud VPC", "contains": ["API Gateway", "User Service", "User DB"] }
    ]
  }
}
```

This extracted structure feeds into the analysis engine — it becomes evidence for architecture domain scoring, risk identification, and recommendation generation.

### Diagram Generation Pipeline

The system generates diagrams as deliverable outputs:

```
Analysis results + findings + target-state proposal
  │
  ├─ Determine which diagrams to generate:
  │   ├─ Current-state system context (if enough info)
  │   ├─ Target-state architecture direction
  │   ├─ Data flow diagram (if data distribution assessed)
  │   ├─ Deployment topology (if infrastructure assessed)
  │   └─ Sequence diagrams for critical flows (if identified)
  │
  ├─ Call Claude to generate Mermaid/PlantUML source code
  │   ├─ System prompt with diagram generation guidelines
  │   ├─ Include assessment context, entities, components
  │   └─ Validate output parses correctly
  │
  ├─ Render to image (PNG/SVG via CLI tool)
  │
  └─ Attach to deliverable section
      ├─ Store as Diagram record (direction=GENERATED)
      ├─ Embed image in deliverable preview
      └─ Include in DOCX export
```

### Diagram Types Generated per Assessment Mode

| Assessment Mode | Diagrams Generated |
|----------------|-------------------|
| **Existing System** | Current-state system context, current-state container diagram, identified problem areas overlay, target-state direction |
| **Greenfield** | Target architecture system context, target container diagram, capability map visualization, phased delivery roadmap diagram |
| **Modernization** | Current-state → target-state comparison, migration sequence, transition architecture states |

### Rendering Infrastructure

For text-based diagrams, the system uses server-side rendering:

| Format | Renderer | Deployment |
|--------|---------|------------|
| Mermaid | `@mermaid-js/mermaid-cli` (mmdc) | npm dependency, runs in Node.js |
| PlantUML | PlantUML server (Docker) | `plantuml/plantuml-server` container in docker-compose |
| Structurizr | Structurizr CLI / Lite | Docker container or CLI tool |

For MVP, **Mermaid is the primary generation target** — it's the simplest to render (Node.js-native), produces good visuals, and Claude generates it reliably. PlantUML generation is MVP+1.

---

## J. Expanded Domain Coverage

### Delivery Strategy Assessment

**Data model:** `DeliveryStrategyAssessment` captures team topology, release model, deployment strategy, branching strategy, environment promotion model.

**Assessment dimensions:**
- Team ownership clarity (1-5)
- Release predictability (1-5)
- Deployment automation (1-5)
- Environment management maturity (1-5)
- Change management maturity (1-5)

**Heuristic rules:** If deployment is manual + release frequency desired is weekly → Flag risk "Manual deployment bottleneck"

### Test Strategy Assessment

**Assessment dimensions:**
- Test pyramid balance (1-5)
- Automation coverage (1-5)
- CI/CD test gate maturity (1-5)
- Test data management (1-5)
- Performance testing readiness (1-5)
- Security testing integration (1-5)

### Data Distribution Assessment

**Assessment dimensions:**
- Integration pattern maturity (1-5)
- Consistency model clarity (1-5)
- Event-driven readiness (1-5)
- Data lineage awareness (1-5)
- Failure handling maturity (1-5)

### Storage Assessment

**Assessment dimensions:**
- Datastore suitability (1-5)
- Schema management maturity (1-5)
- Backup/restore readiness (1-5)
- Scalability model (1-5)
- Security controls (1-5)

### Infrastructure Maturity Assessment

**Assessment dimensions:**
- IaC adoption (1-5)
- Reusability of patterns (1-5)
- Environment consistency (1-5)
- Self-service capability (1-5)
- Drift management (1-5)
- DR readiness (1-5)

---

## K. Greenfield / Startup Workflow

### Tailored Flow

**Stage 1: Vision Capture**
- What is the product? Who are the users?
- What business problem does it solve?
- What are the success metrics?
- What is the timeline and budget envelope?

**Stage 2: Capability Discovery**
- AI proposes a capability map based on the product type
- User confirms/edits required capabilities
- AI identifies sub-capabilities and typical components
- Prioritize: MVP must-have vs. later phases

**Stage 3: Technical Direction**
- AI recommends platform, cloud, and technology options
- Presents pros/cons matrix
- User selects or asks for alternatives
- Architecture direction emerges from selected options

**Stage 4: MVP Scoping**
- AI proposes MVP scope based on priorities and constraints
- Identifies what's in MVP vs. Phase 2, 3
- Flags dependencies and sequencing

**Stage 5: Team & Estimate**
- AI proposes team composition for MVP delivery
- Effort estimation based on capability scope and tech choices
- ROM pricing using configured rate card

**Stage 6: Deliverable Generation**
- Discovery summary
- Capability map
- Architecture direction
- Technology option matrix
- MVP scope definition
- Phased roadmap
- Team proposal
- ROM estimate
- Risks and assumptions

---

## L. MVP Scope

### What to Include in MVP

1. **Two assessment types:**
   - Architecture Assessment (existing system)
   - Discovery Before Implementation (can serve greenfield too)

2. **Core workflow:**
   - Engagement creation and setup
   - Document upload and AI processing
   - Adaptive question generation and answering
   - Domain scoring (manual scoring with AI suggestions)
   - AI-generated findings, risks, recommendations
   - Team composition proposal
   - ROM estimation with configurable rate card
   - Deliverable draft generation (executive summary, assessment report, risk register, team/estimate)
   - Expert review per section (approve/edit/reject)
   - Export to DOCX

3. **Knowledge base (seeded, not fully admin-managed):**
   - 2-3 assessment frameworks
   - Question templates for 5-6 core domains
   - 1 scoring model
   - Sample risk and recommendation patterns
   - 1 rate card
   - 1 role catalog
   - Deliverable templates

4. **Auth:**
   - Simple authentication (email/password or SSO stub)
   - Basic roles: admin, assessor, reviewer

5. **Audit trail:**
   - Record inputs, AI outputs, human edits, approvals

### What to Exclude from MVP

> Annotated 2026-05-13 with shipped status.

| Feature | Target Phase | Shipped? | Rationale |
|---------|-------------|---|-----------|
| Evidence source connectors (repo, IaC, cloud) | MVP+1 | ⚠️ Partial — GitHub repo via tarball + agent harness shipped. IaC / cloud-config / CI/CD connectors not built. | High complexity, core value provable without it |
| Delivery strategy assessment | MVP+1 | ❌ | Valuable but not core to initial proof |
| Test strategy assessment | MVP+1 | ❌ | Same |
| Data distribution assessment | MVP+2 | ❌ | Specialized domain |
| Storage assessment | MVP+2 | ❌ | Specialized domain |
| Infrastructure maturity assessment | MVP+1 | ❌ | Important but can be added after core flow |
| Full greenfield discovery mode | MVP+1 | ✅ Via `greenfield-discovery-v1.docx` deliverable shell | Discovery type covers basics; full capability mapping later |
| Multi-tenant | MVP+2 | ❌ | Single-tenant is fine for internal use |
| Client-facing portal | MVP+2 | ❌ | Internal use first |
| PPTX export | MVP+1 | ❌ (DOCX-only still) | DOCX is sufficient initially |
| Advanced analytics/dashboards | MVP+2 | ❌ | Nice-to-have |
| Full knowledge base admin UI | MVP+1 | ❌ — KB is still JSON-seed-driven by design (see §15 in architecture/README). | Seed via scripts/migrations initially |

### What Can Be Simplified

- Knowledge base seeded from JSON files, not full CRUD UI
- Single assessment per engagement (vs. multiple)
- 5-6 domains active (vs. 20+)
- Export to DOCX and PDF (PPTX deferred)
- Basic auth (no SSO/SAML)
- No real-time collaboration (single-user per section)

---

## M. Technical Implementation Approach

### Recommended Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| **Frontend** | Next.js 15 (App Router, React 19), TypeScript, Tailwind CSS, shadcn/ui | Modern React SSR framework, excellent DX, fast UI iteration |
| **Backend API** | Next.js API Routes + tRPC v11 | Type-safe API layer, collocated with frontend, reduces boilerplate |
| **Database** | PostgreSQL 16 | Robust relational model, JSONB for flexible fields, mature ecosystem |
| **ORM** | Prisma 6 | Type-safe database access, excellent migration support, good with Next.js |
| **Vector + lexical search** | pgvector (HNSW cosine) + `tsvector` GIN (ADR-0027 RRF) | Single Postgres handles both. Hybrid retrieval is flag-gated. |
| **Task Queue** | BullMQ (Redis-backed) | One queue (`document-processing`), 11 job types, worker concurrency 5. |
| **LLM router** | `services/ai/router.ts` over Anthropic primary, OpenAI / Bedrock / Mistral as failover (ADR-0015) | Single entry point for every AI call. Per-task primary + fallback registry, prompt caching opt-in. |
| **Embeddings** | OpenAI `text-embedding-3-small` (1536-dim, ADR-0003), Bedrock Titan v2 fallback for ingest only | Cosine + hybrid retrieval over pgvector. |
| **Blob Storage** | S3 / MinIO (local dev) | Document storage, generated exports, repo tarballs, template fills. |
| **Document Parsing** | pdf-parse, mammoth (DOCX), custom parsers | Extract text from uploaded documents |
| **Export Generation** | `docx` (npm) for DOCX generation | Programmatic DOCX creation from templates (`markdown-to-docx.ts`) |
| **Auth** | NextAuth (credentials, JWT cookies) | Simple, extensible. No server-side session store today. |
| **Deployment** | Docker + docker-compose (dev). Prod-shape TBD. | Simple deployment model, scalable later |
| **Testing** | Vitest (unit + integration), smoke scripts under `scripts/smoke/`. Playwright still on the backlog. | Fast, modern testing stack |

### Why This Stack

- **Monolith-first:** MVP doesn't need microservices. Next.js full-stack gives fast iteration with a single deployable.
- **TypeScript end-to-end:** Type safety from DB (Prisma) through API (tRPC) to UI (React). Catches errors early.
- **PostgreSQL for everything:** Relational data + JSONB for flexible fields + pgvector for embeddings. One database to manage.
- **Async processing:** Document parsing and AI generation are slow — BullMQ handles this without blocking the API.

### Architecture Diagram

```
┌─────────────────────────────────────────────────┐
│              Next.js Application                │
│                                                 │
│  ┌──────────────┐    ┌────────────────────┐     │
│  │   React UI   │    │   tRPC API Router  │     │
│  │  (App Router)│───▶│                    │     │
│  │  Tailwind/   │    │  engagement.*      │     │
│  │  shadcn/ui   │    │  assessment.*      │     │
│  └──────────────┘    │  question.*        │     │
│                      │  finding.*         │     │
│                      │  deliverable.*     │     │
│                      │  knowledge.*       │     │
│                      │  export.*          │     │
│                      └────────┬───────────┘     │
│                               │                 │
│  ┌────────────────────────────┴──────────────┐  │
│  │           Domain Services                 │  │
│  │  AssessmentOrchestrator                   │  │
│  │  DocumentProcessor                        │  │
│  │  QuestionEngine                           │  │
│  │  AnalysisEngine                           │  │
│  │  ScoringService                           │  │
│  │  EstimationService                        │  │
│  │  DeliverableGenerator                     │  │
│  │  ReviewManager                            │  │
│  │  KnowledgeBaseService                     │  │
│  └───┬──────────┬──────────┬─────────────────┘  │
│      │          │          │                    │
│  ┌───┴───┐  ┌──┴────┐  ┌──┴────────┐           │
│  │Prisma │  │BullMQ │  │Claude API │           │
│  │(ORM)  │  │(Queue)│  │(LLM)     │           │
│  └───┬───┘  └──┬────┘  └───────────┘           │
└──────┼─────────┼────────────────────────────────┘
       │         │
  ┌────┴────┐  ┌─┴──────┐  ┌─────────┐
  │PostgreSQL│  │ Redis  │  │ S3/MinIO│
  │+pgvector│  │        │  │ (Blobs) │
  └─────────┘  └────────┘  └─────────┘
```

---

## N. Repo and Project Structure

### Monorepo Structure

```
ai-assessment-copilot/
├── README.md
├── package.json                    # workspace root
├── turbo.json                      # turborepo config
├── docker-compose.yml              # local dev: postgres, redis, minio
├── .env.example
│
├── apps/
│   └── web/                        # Next.js application
│       ├── package.json
│       ├── next.config.ts
│       ├── tailwind.config.ts
│       ├── tsconfig.json
│       │
│       ├── prisma/
│       │   ├── schema.prisma       # database schema
│       │   ├── migrations/         # prisma migrations
│       │   └── seed.ts             # seed knowledge base
│       │
│       ├── src/
│       │   ├── app/                # Next.js app router pages
│       │   │   ├── layout.tsx
│       │   │   ├── page.tsx
│       │   │   ├── (auth)/
│       │   │   │   ├── login/
│       │   │   │   └── register/
│       │   │   ├── engagements/
│       │   │   │   ├── page.tsx            # list
│       │   │   │   ├── new/page.tsx        # create
│       │   │   │   └── [id]/
│       │   │   │       ├── page.tsx        # overview
│       │   │   │       ├── setup/
│       │   │   │       ├── documents/
│       │   │   │       ├── questions/
│       │   │   │       ├── findings/
│       │   │   │       ├── risks/
│       │   │   │       ├── recommendations/
│       │   │   │       ├── scoring/
│       │   │   │       ├── team-estimate/
│       │   │   │       ├── deliverables/
│       │   │   │       └── export/
│       │   │   ├── admin/
│       │   │   │   ├── knowledge/
│       │   │   │   ├── rate-cards/
│       │   │   │   └── users/
│       │   │   └── api/
│       │   │       └── trpc/[trpc]/route.ts
│       │   │
│       │   ├── components/
│       │   │   ├── ui/             # shadcn components
│       │   │   ├── layout/
│       │   │   ├── engagement/
│       │   │   ├── assessment/
│       │   │   ├── questions/
│       │   │   ├── findings/
│       │   │   ├── review/
│       │   │   └── export/
│       │   │
│       │   ├── server/
│       │   │   ├── trpc/
│       │   │   │   ├── router.ts           # root router
│       │   │   │   ├── trpc.ts             # tRPC setup
│       │   │   │   └── routers/
│       │   │   │       ├── engagement.ts
│       │   │   │       ├── assessment.ts
│       │   │   │       ├── document.ts
│       │   │   │       ├── question.ts
│       │   │   │       ├── finding.ts
│       │   │   │       ├── risk.ts
│       │   │   │       ├── recommendation.ts
│       │   │   │       ├── scoring.ts
│       │   │   │       ├── estimation.ts
│       │   │   │       ├── deliverable.ts
│       │   │   │       ├── review.ts
│       │   │   │       ├── knowledge.ts
│       │   │   │       └── export.ts
│       │   │   │
│       │   │   ├── services/
│       │   │   │   ├── assessment-orchestrator.ts
│       │   │   │   ├── document-processor.ts
│       │   │   │   ├── question-engine.ts
│       │   │   │   ├── analysis-engine.ts
│       │   │   │   ├── scoring-service.ts
│       │   │   │   ├── estimation-service.ts
│       │   │   │   ├── deliverable-generator.ts
│       │   │   │   ├── review-manager.ts
│       │   │   │   ├── knowledge-base.ts
│       │   │   │   ├── export-service.ts
│       │   │   │   └── ai/
│       │   │   │       ├── claude-client.ts
│       │   │   │       ├── prompts/
│       │   │   │       │   ├── document-analysis.ts
│       │   │   │       │   ├── question-generation.ts
│       │   │   │       │   ├── finding-generation.ts
│       │   │   │       │   ├── risk-generation.ts
│       │   │   │       │   ├── recommendation-generation.ts
│       │   │   │       │   ├── deliverable-drafting.ts
│       │   │   │       │   └── estimation-support.ts
│       │   │   │       └── schemas/
│       │   │   │           ├── document-analysis-schema.ts
│       │   │   │           ├── question-schema.ts
│       │   │   │           └── finding-schema.ts
│       │   │   │
│       │   │   ├── queue/
│       │   │   │   ├── worker.ts
│       │   │   │   ├── jobs/
│       │   │   │   │   ├── process-document.ts
│       │   │   │   │   ├── generate-questions.ts
│       │   │   │   │   ├── run-analysis.ts
│       │   │   │   │   └── generate-deliverable.ts
│       │   │   │   └── queue.ts
│       │   │   │
│       │   │   └── db.ts                   # prisma client
│       │   │
│       │   ├── lib/
│       │   │   ├── utils.ts
│       │   │   ├── auth.ts
│       │   │   └── constants.ts
│       │   │
│       │   └── types/
│       │       └── index.ts
│       │
│       └── tests/
│           ├── unit/
│           ├── integration/
│           └── e2e/
│
├── packages/
│   └── knowledge-seed/             # seed data for knowledge base
│       ├── package.json
│       ├── frameworks/
│       ├── checklists/
│       ├── question-templates/
│       ├── risk-patterns/
│       ├── recommendation-patterns/
│       ├── role-catalog/
│       ├── rate-cards/
│       ├── estimation-heuristics/
│       ├── deliverable-templates/
│       ├── scoring-models/
│       └── index.ts                # export all seed data
│
└── docs/
    ├── design/
    │   └── product-design.md       # this document
    ├── api/
    └── guides/
```

---

## O. Delivery Roadmap

> **Status — historical / superseded.** Phases 0–4 below were the
> originally-planned MVP delivery shape. The plan rolled forward into
> two real-world phases that are tracked in their own documents:
>
> - [`phase-3-roadmap.md`](./phase-3-roadmap.md) — "real-world scale"
>   roadmap (eight weeks, shipped).
>   See [`phase-3-retrospective.md`](./phase-3-retrospective.md).
> - [`phase-4-agentic-ai.md`](./phase-4-agentic-ai.md) — ongoing
>   agentic-AI roadmap (Slices 0, 1, 3.5 shipped; substantial work
>   landed outside the original slice plan).
>
> Treat the phase-by-phase list below as a record of the original
> sequencing, not the current state.

### Phase 0: Design & Foundation (Weeks 1-2)

- Finalize product design document
- Set up monorepo, tooling, CI
- Set up Docker dev environment (Postgres, Redis, MinIO)
- Create Prisma schema with core entities
- Run initial migrations
- Set up Next.js with App Router, Tailwind, shadcn/ui
- Set up tRPC
- Set up NextAuth with basic credentials auth
- Create seed data structure for knowledge base

**Exit criteria:** Empty app runs, DB schema applied, auth works, project structure established.

### Phase 1: MVP Foundations (Weeks 3-5)

- Engagement CRUD (create, list, view)
- Assessment setup (select type, mode, configure domains)
- Document upload + storage (S3/MinIO)
- Document processing pipeline (extract text, summarize via Claude)
- Project context capture form
- Basic dashboard showing engagement status
- Knowledge base seeding script (load JSON seed data)
- Audit trail logging foundation

**Exit criteria:** User can create engagement, upload documents, see AI summary of documents.

### Phase 2: Intelligent Intake & Assessment Engine (Weeks 6-9)

- Question engine: generate questions from templates + AI
- Question/answer UI: domain-grouped, priority-sorted
- Adaptive follow-up question generation
- Domain scoring: configurable rubric, AI-suggested scores
- Finding generation: AI proposes findings from evidence
- Risk generation: AI proposes risks from evidence + patterns
- Recommendation generation: AI proposes recommendations
- Assumption tracking
- Coverage dashboard: what % of each domain has been answered
- Knowledge base retrieval (vector search for relevant patterns)

**Exit criteria:** Full intake → analysis cycle works. AI generates meaningful findings, risks, recommendations from uploaded documents and answered questions.

### Phase 3: Estimation & Deliverable Generation (Weeks 10-12)

- Team composition engine: propose roles from assessment results + heuristics
- Estimation engine: calculate effort ranges using rules + AI support
- Rate card management (admin)
- Pricing calculation
- Deliverable template system
- Deliverable generation: AI drafts each section using templates + assessment data
- Export to DOCX
- Deliverable preview in UI

**Exit criteria:** End-to-end flow from intake to exported DOCX deliverable works.

### Phase 4: Review, Approval & Hardening (Weeks 13-15)

- Per-section review workflow (approve/edit/reject/revise)
- Review dashboard showing progress
- Edit tracking (who changed what)
- Approval gate before export
- Role-based access enforcement
- Error handling, edge cases, loading states
- Performance optimization
- End-to-end testing
- Bug fixes and polish

**Exit criteria:** MVP is usable for a real internal assessment engagement. Review workflow is complete. Export produces client-ready draft.

### Phase 5: MVP+1 (Weeks 16-20+)

- ✅ Evidence source connectors (GitHub) — shipped via repo-link
  tarball ingest (ADR-0009 / 0010) and the agent harness (ADR-0014 /
  0017 / 0021 / 0026).
- ⚠️ Artifact validation workflow — partially shipped via the
  evidence-explorer + Why-this-finding panel (ADR-0011 / 0028).
  An explicit "ArtifactValidation" contradiction model was not built.
- ✅ Customer-uploadable templates (ADR-0018) — not on the original
  list but landed in Phase 4.
- ✅ Full greenfield discovery mode — shipped via the
  `greenfield-discovery-v1.docx` deliverable shell + binding.
- ❌ Delivery / test / infrastructure maturity dedicated assessment
  domains — not built as separate domains; coverage is achieved via
  configurable `Assessment.activeDomains`.
- ❌ Knowledge base admin UI — KB is still JSON-file-driven via
  `packages/knowledge-seed/`. Decision documented in ADR-0023
  (DB-backed flags) and the architecture README.
- ❌ PPTX export.
- ❌ Multi-tenancy.
- ⚠️ Performance & scalability — Phase 3 hit the volume targets;
  formal load test suite remains on the backlog.

---

## P. Risks and Design Cautions

| Risk | Impact | Mitigation |
|------|--------|------------|
| **LLM output quality inconsistency** | Findings/reports vary in quality | Structured prompts, output schema validation, few-shot examples, mandatory expert review |
| **Over-reliance on AI** | Users skip review, accept bad outputs | Mandatory review gates, confidence flagging, "needs validation" markers |
| **Knowledge base cold start** | Poor results without good seed data | Invest in quality seed content; partner with experienced architects for initial frameworks |
| **Scope creep in MVP** | Never ships | Strict MVP scope freeze; park features in backlog |
| **Document parsing accuracy** | Bad extraction → bad analysis | Support multiple formats; show extracted text for user validation; allow manual correction |
| **Estimation accuracy expectations** | Users treat ROM as commitment | Clear "indicative" labeling; show assumptions and confidence; require human approval |
| **Prompt injection via documents** | Uploaded docs manipulate AI | Sanitize extracted text; separate user instructions from document content in prompts |
| **Data confidentiality** | Client data leak | Encryption at rest/transit; tenant isolation; access controls; audit logging |
| **LLM cost management** | High API costs at scale | Cache common operations; batch processing; prompt optimization; token budgets per assessment |
| **User adoption** | Tool seen as overhead, not accelerator | Fast time-to-value; don't force rigid process; allow skipping sections; show clear time savings |
