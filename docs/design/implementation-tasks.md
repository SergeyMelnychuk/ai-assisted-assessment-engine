# First Implementation Tasks — Execution Order

> **Status: historical (Phase 1 kickoff playbook).** Every task in
> this document landed. The job names and file paths below reflect
> the original plan — several have since been renamed or moved.
> Notable shifts from this kickoff list:
>
> - `process-document` / `process-diagram` jobs were renamed
>   `ingest-document` / `ingest-diagram` in Phase 3 Week 1
>   (ADR-0001), when ingest was decoupled from analyse.
> - Authed pages live under `src/app/(app)/engagements/[id]/...`
>   (route group `(app)` added with NextAuth refinements).
> - Direct `@anthropic-ai/sdk` calls were replaced by the AI router
>   in Phase 4 (ADR-0015 / 0016).
> - The "Analysis engine" task became a per-domain fan-out with
>   verifier pass (ADR-0002 / 0013).
> - Diagram generation now goes through the same AI router task
>   (`diagram.generate`), with one call per planned diagram.
>
> For current architecture and conventions, see:
>
> - `docs/architecture/README.md`
> - `docs/architecture/decisions/` (ADRs 0001–0028)
> - `CLAUDE.md` (repo-root)

These tasks should be executed in sequence. Each builds on the previous.

---

## Task 1: Bootstrap the development environment

**Goal:** Get the dev stack running locally.

1. Install pnpm: `npm install -g pnpm@9`
2. Run `pnpm install` from the repo root
3. Run `docker-compose up -d` to start PostgreSQL (pgvector), Redis, MinIO
4. Copy `.env.example` to `apps/web/.env` and fill in Anthropic API key
5. Run `pnpm db:generate` to generate the Prisma client
6. Run `pnpm db:migrate` to apply the schema
7. Run `pnpm db:seed` to seed assessment types, rate card, demo user
8. Run `pnpm dev` to start the Next.js dev server
9. Verify: app loads at `http://localhost:3000`

**Files to create/edit:** None — all config files already exist.

---

## Task 2: Authentication (NextAuth)

**Goal:** Users can register and log in.

1. Set up NextAuth with credentials provider in `src/app/api/auth/[...nextauth]/route.ts`
2. Implement password hashing with bcrypt
3. Create login page at `src/app/(auth)/login/page.tsx`
4. Create register page at `src/app/(auth)/register/page.tsx`
5. Add session provider to root layout
6. Add auth middleware to protect routes
7. Wire up tRPC context to include session

**Key files:**
- `src/app/api/auth/[...nextauth]/route.ts`
- `src/app/(auth)/login/page.tsx`
- `src/app/(auth)/register/page.tsx`
- `src/lib/auth.ts`
- `src/app/layout.tsx`

---

## Task 3: App shell and layout

**Goal:** Basic navigation, sidebar, responsive layout.

1. Create root layout with sidebar navigation
2. Create top bar with user menu / logout
3. Create sidebar with navigation links:
   - Engagements (list)
   - Admin > Knowledge Base (stub)
   - Admin > Rate Cards (stub)
4. Set up Tailwind CSS variables and shadcn/ui base components (Button, Card, Input, etc.)
5. Create a loading skeleton component

**Key files:**
- `src/app/layout.tsx`
- `src/components/layout/sidebar.tsx`
- `src/components/layout/top-bar.tsx`
- `src/components/ui/*.tsx` (shadcn components)

---

## Task 4: tRPC client setup

**Goal:** Frontend can call tRPC endpoints.

1. Set up tRPC client provider with React Query
2. Create the API route handler at `src/app/api/trpc/[trpc]/route.ts`
3. Create a `trpc.ts` client utility for use in components
4. Verify: a simple query from the frontend hits the backend

**Key files:**
- `src/app/api/trpc/[trpc]/route.ts`
- `src/lib/trpc.ts` (client-side)
- `src/components/providers.tsx`

---

## Task 5: Engagement CRUD

**Goal:** Users can create, list, and view engagements.

1. Build the engagements list page (`/engagements`)
2. Build the create engagement form (`/engagements/new`)
3. Build the engagement detail page (`/engagements/[id]`)
4. Wire up to `engagement.list`, `engagement.create`, `engagement.getById` tRPC routes
5. Add empty states, loading states, error handling

**Key files:**
- `src/app/engagements/page.tsx`
- `src/app/engagements/new/page.tsx`
- `src/app/engagements/[id]/page.tsx`
- `src/components/engagement/engagement-list.tsx`
- `src/components/engagement/create-engagement-form.tsx`

---

## Task 6: Assessment setup

**Goal:** Within an engagement, users can create and configure an assessment.

1. Build assessment setup page (`/engagements/[id]/setup`)
2. Select assessment type from seeded types
3. Select assessment mode (existing system, greenfield, etc.)
4. Select active domains (checkboxes, pre-filled from assessment type defaults)
5. Save via `assessment.create` tRPC route
6. Build project context form (project name, description, goals, constraints, tech stack, etc.)
7. Save via `assessment.updateProjectContext` tRPC route

**Key files:**
- `src/app/engagements/[id]/setup/page.tsx`
- `src/components/assessment/assessment-setup-form.tsx`
- `src/components/assessment/project-context-form.tsx`

---

## Task 7: Document upload and processing (including diagrams)

**Goal:** Users can upload documents and architecture diagrams; system extracts text, parses diagrams, and generates AI summaries.

1. Build the documents page (`/engagements/[id]/documents`)
2. Implement file upload UI (drag-and-drop, file picker) — supports docs AND diagram formats
3. Create upload API route that stores file in S3/MinIO
4. Auto-detect diagram formats (Mermaid, PlantUML, Structurizr DSL, WSD, PNG, SVG, JPEG) via `detectDiagramFormat()`
5. Set up BullMQ worker for document/diagram processing
6. Implement document processing job:
   a. Download file from S3
   b. Extract text (pdf-parse for PDF, mammoth for DOCX, raw for text)
   c. Call Claude to analyze and summarize the document
   d. Store extracted text, summary, and evidence in DB
7. Implement diagram processing job:
   a. For text-based diagrams: parse source, extract entities (components, services, connections, datastores, boundaries), render to image via Mermaid CLI
   b. For image-based diagrams (PNG/JPEG/SVG): call Claude vision to describe and extract entities
   c. Store Diagram record with source code, extracted entities, summary, and rendered image path
   d. Create Evidence records from extracted diagram entities (feeds into architecture domain scoring)
8. Show processing status in UI (pending → processing → processed)
9. Display extracted summary + diagram preview with edit capability
10. Show extracted entities in a structured view (components list, connections, etc.)

**Key files:**
- `src/app/engagements/[id]/documents/page.tsx`
- `src/components/assessment/document-upload.tsx`
- `src/components/assessment/diagram-viewer.tsx`
- `src/server/trpc/routers/document.ts`
- `src/server/services/document-processor.ts`
- `src/server/services/diagram-parser.ts`
- `src/server/services/ai/prompts/diagram-analysis.ts`
- `src/server/queue/jobs/process-document.ts`
- `src/server/queue/jobs/process-diagram.ts`
- `src/server/queue/worker.ts`
- `src/server/queue/queue.ts`

---

## Task 8: Question engine (initial)

**Goal:** System generates questions based on assessment type and collected evidence.

1. Build questions page (`/engagements/[id]/questions`)
2. Group questions by domain, sort by priority
3. Create tRPC route to generate initial questions (from templates + AI)
4. Create tRPC route to answer a question
5. Implement question generation service:
   a. Load question templates from knowledge base for active domains
   b. Call Claude to generate context-aware follow-up questions
   c. Store questions in DB
6. After answering, trigger follow-up question generation
7. Show coverage progress per domain

**Key files:**
- `src/app/engagements/[id]/questions/page.tsx`
- `src/components/questions/question-list.tsx`
- `src/components/questions/answer-form.tsx`
- `src/server/trpc/routers/question.ts`
- `src/server/services/question-engine.ts`

---

## Task 9: Analysis engine — findings, risks, recommendations

**Goal:** AI generates findings, risks, and recommendations from collected evidence.

1. Build findings page (`/engagements/[id]/findings`)
2. Build risks page (`/engagements/[id]/risks`)
3. Build recommendations page (`/engagements/[id]/recommendations`)
4. Create "Run Analysis" action that triggers AI analysis
5. Implement analysis service:
   a. Gather all evidence (documents, answers)
   b. Retrieve relevant risk/recommendation patterns from knowledge base
   c. Call Claude to generate findings, risks, recommendations
   d. Store results with confidence levels and evidence links
6. Build domain scoring UI — AI suggests scores, expert adjusts
7. Each item shows confidence badge, evidence links, review status

**Key files:**
- `src/app/engagements/[id]/findings/page.tsx`
- `src/app/engagements/[id]/risks/page.tsx`
- `src/app/engagements/[id]/recommendations/page.tsx`
- `src/app/engagements/[id]/scoring/page.tsx`
- `src/server/trpc/routers/finding.ts`
- `src/server/trpc/routers/risk.ts`
- `src/server/trpc/routers/recommendation.ts`
- `src/server/trpc/routers/scoring.ts`
- `src/server/services/analysis-engine.ts`
- `src/server/services/scoring-service.ts`

---

## Task 10: Team composition and estimation

**Goal:** AI proposes team and effort estimate; consultant reviews and adjusts.

1. Build team/estimate page (`/engagements/[id]/team-estimate`)
2. Implement estimation service:
   a. Analyze assessment results (scope, complexity, domains)
   b. Propose team roles using role catalog + heuristics
   c. Calculate effort ranges
   d. Apply rate card to calculate pricing
3. Show team proposal with justifications
4. Show effort breakdown by role
5. Show pricing summary with assumptions
6. Allow editing: adjust roles, hours, rates

**Key files:**
- `src/app/engagements/[id]/team-estimate/page.tsx`
- `src/components/assessment/team-proposal.tsx`
- `src/components/assessment/estimate-summary.tsx`
- `src/server/trpc/routers/estimation.ts`
- `src/server/services/estimation-service.ts`

---

## Task 11: Deliverable generation (including diagram generation)

**Goal:** System drafts deliverable sections using templates + AI, and generates architecture diagrams.

1. Build deliverables page (`/engagements/[id]/deliverables`)
2. Implement deliverable generator service:
   a. Load deliverable template (e.g., assessment report template)
   b. For each section, generate content using AI + structured data
   c. Store draft sections
3. Implement diagram generation as part of deliverable creation:
   a. Use `planDiagramsForDeliverable()` to determine which diagrams to generate based on assessment mode and available data
   b. Call Claude to generate Mermaid source code for each diagram (system context, target-state, deployment, data flow, sequence)
   c. Render Mermaid source to SVG/PNG via mermaid-cli (`mmdc`)
   d. Store Diagram records (direction=GENERATED) linked to the deliverable
   e. Embed rendered diagrams in relevant deliverable sections
4. Show deliverable with section list
5. Preview each section content (markdown rendered) with embedded diagram images
6. Allow consultants to view/edit diagram source code and re-render
7. Support diagram regeneration with natural-language feedback ("make it more detailed", "add the Redis cache")

**Key files:**
- `src/app/engagements/[id]/deliverables/page.tsx`
- `src/components/assessment/deliverable-preview.tsx`
- `src/components/assessment/diagram-editor.tsx`
- `src/server/trpc/routers/deliverable.ts`
- `src/server/services/deliverable-generator.ts`
- `src/server/services/diagram-generator.ts`
- `src/server/services/ai/prompts/diagram-generation.ts`

---

## Task 12: Expert review workflow

**Goal:** Reviewers can approve, edit, or reject deliverable sections.

1. Add review controls to each deliverable section
2. Inline editing of section content
3. Approve / reject / request revision buttons
4. Track review history (who, when, what changed)
5. Show review progress dashboard
6. Enforce: all required sections must be approved before export

**Key files:**
- `src/components/review/section-review.tsx`
- `src/components/review/review-dashboard.tsx`
- `src/server/trpc/routers/review.ts`
- `src/server/services/review-manager.ts`

---

## Task 13: Export to DOCX (with embedded diagrams)

**Goal:** Export approved deliverables as a professional DOCX file, including architecture diagrams.

1. Build export page (`/engagements/[id]/export`)
2. Implement DOCX generation using the `docx` npm package
3. Apply professional formatting (headings, tables, page breaks)
4. Embed generated and uploaded diagram images in relevant sections
   a. Fetch rendered diagram images (PNG/SVG) from S3
   b. Insert as inline images in the DOCX at the appropriate section
   c. Add figure captions with diagram title
5. Include only approved sections (or mark draft sections clearly)
6. Generate and store in S3
7. Provide download link

**Key files:**
- `src/app/engagements/[id]/export/page.tsx`
- `src/server/trpc/routers/export.ts`
- `src/server/services/export-service.ts`

---

## Summary: Execution Order

| # | Task | Depends On | Estimated Complexity |
|---|------|-----------|---------------------|
| 1 | Dev environment bootstrap | — | Low |
| 2 | Authentication | 1 | Medium |
| 3 | App shell and layout | 1 | Medium |
| 4 | tRPC client setup | 2, 3 | Low |
| 5 | Engagement CRUD | 4 | Medium |
| 6 | Assessment setup | 5 | Medium |
| 7 | Document upload, processing & diagram parsing | 6 | High |
| 8 | Question engine | 7 | High |
| 9 | Analysis engine | 8 | High |
| 10 | Team & estimation | 9 | High |
| 11 | Deliverable generation + diagram generation | 10 | High |
| 12 | Expert review | 11 | Medium |
| 13 | Export to DOCX | 12 | Medium |

Tasks 2 and 3 can be done in parallel. Tasks 7-11 are the core AI-powered features and represent the bulk of the effort.
