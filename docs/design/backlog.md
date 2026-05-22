# Initial Backlog — Epics and Key User Stories

> **Status: historical (kickoff document).** This is the original
> epic-level backlog from project kickoff. Almost every P0 / P1 item
> has shipped; some P2 / P3 items shipped via different shapes than
> originally planned. For the current state, see:
>
> - `docs/architecture/README.md` — what the system does today.
> - `docs/architecture/decisions/` (ADRs 0001–0028) — *why* each
>   non-obvious shape exists.
> - `docs/design/phase-3-retrospective.md` and
>   `docs/design/phase-4-agentic-ai.md` — what shipped per phase.
> - `docs/design/product-design.md` — canonical product spec.
>
> Notable deltas from this kickoff list:
>
> - **Epic 13 (Evidence Connectors)** shipped as a GitHub-only
>   tarball ingest (ADR-0009 / 0010 / 0022) plus a full agent
>   harness (ADR-0014 / 0017). GitLab and the "ArtifactValidation"
>   contradiction model haven't been built.
> - **Diagram support (Epic 10b)** shipped for the ingest path
>   (text + vision) and for the AI-generated diagram path
>   (Mermaid). PlantUML / Structurizr generation (10b.19 / 10b.20)
>   stayed at parsing-only.
> - **Epic 9 Review** shipped with a richer review-manager + audit
>   trail than this list anticipated; cross-reference `docs/operations/`.
> - **Playwright E2E (1.9)** still outstanding — see Phase 3
>   retrospective.

## Epic 1: Project Setup & Infrastructure

| ID | Story | Priority |
|----|-------|----------|
| 1.1 | Set up monorepo with Turborepo, TypeScript, ESLint, Prettier | P0 |
| 1.2 | Set up Docker Compose for local dev (PostgreSQL + pgvector, Redis, MinIO) | P0 |
| 1.3 | Set up Next.js app with App Router, Tailwind CSS, shadcn/ui | P0 |
| 1.4 | Set up Prisma ORM with initial schema and migrations | P0 |
| 1.5 | Set up tRPC with Next.js integration | P0 |
| 1.6 | Set up NextAuth.js with credentials provider | P0 |
| 1.7 | Set up BullMQ with Redis for async job processing | P0 |
| 1.8 | Set up S3/MinIO client for blob storage | P0 |
| 1.9 | Set up Vitest for unit tests and Playwright for e2e | P1 |
| 1.10 | Create CI pipeline (lint, type-check, test, build) | P1 |

## Epic 2: Engagement Management

| ID | Story | Priority |
|----|-------|----------|
| 2.1 | As a consultant, I can create a new engagement with name, client, industry | P0 |
| 2.2 | As a consultant, I can see a list of my engagements with status | P0 |
| 2.3 | As a consultant, I can open an engagement and see its overview dashboard | P0 |
| 2.4 | As an admin, I can invite team members to an engagement and assign roles | P1 |
| 2.5 | As a consultant, I can archive a completed engagement | P2 |

## Epic 3: Assessment Setup

| ID | Story | Priority |
|----|-------|----------|
| 3.1 | As a consultant, I can create an assessment within an engagement | P0 |
| 3.2 | As a consultant, I can select an assessment type (Architecture Assessment, Discovery) | P0 |
| 3.3 | As a consultant, I can select an assessment mode (Existing System, Greenfield) | P0 |
| 3.4 | As a consultant, I can configure which domains are active for this assessment | P0 |
| 3.5 | As a consultant, I can fill in project context (name, description, goals, constraints, tech stack, cloud, timeline) | P0 |
| 3.6 | As a consultant, I can see the assessment progress through stages | P0 |

## Epic 4: Document Upload & Processing

| ID | Story | Priority |
|----|-------|----------|
| 4.1 | As a consultant, I can upload documents (PDF, DOCX, TXT, MD, images) to an assessment | P0 |
| 4.2 | As a consultant, I can tag uploaded documents by type (RFP, architecture doc, NFR, etc.) | P0 |
| 4.3 | The system extracts text content from uploaded documents asynchronously | P0 |
| 4.4 | The system generates an AI summary of each uploaded document | P0 |
| 4.5 | As a consultant, I can see the extracted summary and correct it if needed | P0 |
| 4.6 | The system extracts structured evidence from documents and stores with domain tags | P0 |
| 4.7 | As a consultant, I can see a consolidated "what we know so far" view from all documents | P1 |

## Epic 5: Adaptive Question Engine

| ID | Story | Priority |
|----|-------|----------|
| 5.1 | The system generates initial questions based on assessment type, mode, and active domains | P0 |
| 5.2 | As a consultant, I can see questions grouped by domain with priority indicators | P0 |
| 5.3 | As a consultant, I can answer questions (free text, choice, file upload) | P0 |
| 5.4 | The system generates follow-up questions based on previous answers | P0 |
| 5.5 | The system identifies and highlights missing critical information per domain | P0 |
| 5.6 | As a consultant, I can see coverage progress per domain (% answered, confidence) | P1 |
| 5.7 | The system explains why a question is being asked (rationale) | P1 |
| 5.8 | The system suggests evidence to request when answers are insufficient | P1 |

## Epic 6: Analysis & Scoring

| ID | Story | Priority |
|----|-------|----------|
| 6.1 | The system scores each active domain using configurable maturity rubrics | P0 |
| 6.2 | As a consultant, I can see domain scores with AI-suggested values and adjust them | P0 |
| 6.3 | The system generates findings (strengths, weaknesses, gaps, observations) from evidence | P0 |
| 6.4 | Each finding includes confidence level and linked evidence | P0 |
| 6.5 | The system generates risks with impact, likelihood, and mitigation proposals | P0 |
| 6.6 | The system generates recommendations with priority and effort indication | P0 |
| 6.7 | The system tracks assumptions explicitly, distinguishing facts from inferences | P0 |
| 6.8 | As a consultant, I can see all findings/risks/recommendations in filterable lists | P0 |
| 6.9 | As a consultant, I can edit, accept, or reject any AI-generated finding/risk/recommendation | P0 |

## Epic 7: Team Composition & Estimation

| ID | Story | Priority |
|----|-------|----------|
| 7.1 | The system proposes team composition based on assessment results and heuristics | P0 |
| 7.2 | Each proposed role includes justification, responsibilities, and seniority | P0 |
| 7.3 | The system calculates effort ranges (hours/days) using estimation heuristics | P0 |
| 7.4 | The system calculates pricing using a configurable rate card | P0 |
| 7.5 | As a consultant, I can see, edit, and approve the team and estimate | P0 |
| 7.6 | As a consultant, I can create multiple estimation scenarios (conservative, recommended, aggressive) | P1 |
| 7.7 | Estimates clearly show assumptions and confidence levels | P0 |
| 7.8 | As an admin, I can manage rate cards | P1 |

## Epic 8: Deliverable Generation

| ID | Story | Priority |
|----|-------|----------|
| 8.1 | The system generates a draft executive summary from assessment data | P0 |
| 8.2 | The system generates a draft assessment report with findings by domain | P0 |
| 8.3 | The system generates a draft risk register | P0 |
| 8.4 | The system generates a draft team composition and estimate section | P0 |
| 8.5 | The system generates a draft assumptions and open questions section | P0 |
| 8.6 | As a consultant, I can preview each deliverable section in the UI | P0 |
| 8.7 | Deliverable sections reference source evidence (traceability) | P0 |
| 8.8 | The system generates a draft roadmap / next steps section | P1 |
| 8.9 | The system generates a draft target-state architecture direction | P1 |

## Epic 9: Expert Review & Approval

| ID | Story | Priority |
|----|-------|----------|
| 9.1 | As a reviewer, I can see a review dashboard showing all sections and their status | P0 |
| 9.2 | As a reviewer, I can approve a deliverable section | P0 |
| 9.3 | As a reviewer, I can edit a deliverable section (inline editing) | P0 |
| 9.4 | As a reviewer, I can reject a section with comments | P0 |
| 9.5 | As a reviewer, I can request revision of a section | P0 |
| 9.6 | The system tracks who reviewed/edited what and when | P0 |
| 9.7 | The system enforces that all required sections are approved before export | P0 |
| 9.8 | The system clearly distinguishes AI draft content from human-approved content | P0 |

## Epic 10: Export

| ID | Story | Priority |
|----|-------|----------|
| 10.1 | As a consultant, I can export the assessment deliverables as a DOCX file | P0 |
| 10.2 | Exported DOCX follows a professional template with consistent formatting | P0 |
| 10.3 | Export includes only approved sections (or clearly marks draft sections) | P0 |
| 10.4 | As a consultant, I can download the exported file from the UI | P0 |
| 10.5 | Export to PDF | P2 |
| 10.6 | Export to PPTX (presentation format) | P2 |

## Epic 10b: Architecture Diagram Support

### Diagram Ingestion (Parsing)

| ID | Story | Priority |
|----|-------|----------|
| 10b.1 | As a consultant, I can upload architecture diagrams (Mermaid, PlantUML, Structurizr DSL, PNG, SVG, JPEG) alongside other documents | P0 |
| 10b.2 | The system auto-detects the diagram format from file extension and content | P0 |
| 10b.3 | For text-based diagrams (Mermaid, PlantUML, Structurizr, WSD), the system parses the source and extracts components, services, connections, datastores, and boundaries | P0 |
| 10b.4 | For image-based diagrams (PNG, JPEG, SVG), the system uses Claude vision to describe the diagram and extract entities | P0 |
| 10b.5 | The system generates a natural-language summary of each uploaded diagram | P0 |
| 10b.6 | Extracted diagram entities feed into the analysis engine as evidence for the architecture domain | P0 |
| 10b.7 | As a consultant, I can view extracted entities and the AI-generated summary, and correct them | P1 |
| 10b.8 | The system renders text-based diagram sources to images for preview in the UI | P1 |
| 10b.9 | The system parses Draw.io / diagrams.net XML files | P2 |
| 10b.10 | The system parses WebSequenceDiagrams (.wsd) files | P1 |

### Diagram Generation (Output)

| ID | Story | Priority |
|----|-------|----------|
| 10b.11 | The system generates a current-state system context diagram (Mermaid) from assessment data for existing-system assessments | P0 |
| 10b.12 | The system generates a target-state architecture direction diagram (Mermaid) as part of deliverables | P0 |
| 10b.13 | The system generates deployment topology diagrams when infrastructure data is available | P1 |
| 10b.14 | The system generates data flow diagrams when data distribution domain is assessed | P1 |
| 10b.15 | The system generates sequence diagrams for critical flows identified during assessment | P1 |
| 10b.16 | For greenfield assessments, the system generates a proposed system context diagram | P0 |
| 10b.17 | Generated diagrams are embedded in deliverable sections and included in DOCX export | P0 |
| 10b.18 | As a consultant, I can preview generated diagrams and request regeneration with feedback | P1 |
| 10b.19 | The system can generate PlantUML output in addition to Mermaid | P2 |
| 10b.20 | The system can generate Structurizr DSL output for C4 model diagrams | P2 |
| 10b.21 | As a consultant, I can edit generated diagram source code and see the re-rendered result | P1 |

## Epic 11: Knowledge Base

| ID | Story | Priority |
|----|-------|----------|
| 11.1 | Seed the knowledge base with initial assessment frameworks (Architecture Assessment, Discovery) | P0 |
| 11.2 | Seed question templates for core domains (business, architecture, security, NFRs, DevOps, delivery) | P0 |
| 11.3 | Seed scoring models (5-level maturity scale) | P0 |
| 11.4 | Seed risk patterns (20-30 common patterns) | P0 |
| 11.5 | Seed recommendation patterns (20-30 common patterns) | P0 |
| 11.6 | Seed role catalog with standard consulting/delivery roles | P0 |
| 11.7 | Seed default rate card | P0 |
| 11.8 | Seed estimation heuristics | P0 |
| 11.9 | Seed deliverable templates (executive summary, assessment report, risk register) | P0 |
| 11.10 | As an admin, I can view and edit knowledge base artifacts via admin UI | P1 |
| 11.11 | Knowledge artifacts are versioned (version number incremented on edit) | P1 |

## Epic 12: Audit Trail

| ID | Story | Priority |
|----|-------|----------|
| 12.1 | The system logs all significant actions (create, update, AI generation, review, approval) | P0 |
| 12.2 | As an admin, I can view the audit trail for an assessment | P1 |
| 12.3 | Audit records include who, what, when, and the before/after state | P1 |

## Epic 13: Evidence Connectors (MVP+1)

| ID | Story | Priority |
|----|-------|----------|
| 13.1 | As a consultant, I can connect a GitHub/GitLab repository to an assessment | P2 |
| 13.2 | The system analyzes repository structure, languages, dependencies, test coverage | P2 |
| 13.3 | The system ingests IaC files (Terraform, CloudFormation) and extracts infrastructure signals | P2 |
| 13.4 | The system validates stakeholder claims against artifact evidence | P2 |
| 13.5 | The system records contradictions as ArtifactValidation records for expert review | P2 |

## Epic 14: Expanded Domain Assessments (MVP+1)

| ID | Story | Priority |
|----|-------|----------|
| 14.1 | Add Delivery Strategy assessment domain with dedicated questions and scoring | P2 |
| 14.2 | Add Test Strategy assessment domain with dedicated questions and scoring | P2 |
| 14.3 | Add Infrastructure Maturity assessment domain | P2 |
| 14.4 | Add Data Distribution assessment domain | P3 |
| 14.5 | Add Storage / Persistence assessment domain | P3 |

## Epic 15: Full Greenfield Discovery (MVP+1)

| ID | Story | Priority |
|----|-------|----------|
| 15.1 | Capability mapping workflow: AI proposes capability map, user edits | P2 |
| 15.2 | Technology option matrix: AI recommends options with pros/cons | P2 |
| 15.3 | MVP scoping: AI proposes MVP vs. later phases | P2 |
| 15.4 | Greenfield-specific deliverables: capability outline, platform recommendation | P2 |

---

## Priority Legend

| Priority | Meaning |
|----------|---------|
| P0 | Must have for MVP — blocking for core value delivery |
| P1 | Should have for MVP — significant value but not blocking |
| P2 | MVP+1 — next release after MVP |
| P3 | Future — valuable but not near-term |
