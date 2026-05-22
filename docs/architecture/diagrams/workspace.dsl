workspace "Assessment Co-Pilot" "AI-assisted platform for early-phase software consulting engagements (discovery, architecture assessment, modernization, audit, solution shaping, estimation)." {

    !identifiers hierarchical

    model {
        // ─── External actors ────────────────────────────────────────
        consultant = person "Consultant / Assessor" "Runs assessments, uploads documents, answers intake questions, edits deliverables." "user"
        reviewer = person "Reviewer / Architect" "Approves or rejects AI-drafted sections, signs off deliverables for export." "user"
        admin = person "Admin" "Manages users, audits the knowledge base, inspects rate cards." "user"

        // ─── External systems ───────────────────────────────────────
        anthropic = softwareSystem "Anthropic Claude" "Primary LLM provider — text + vision. Multi-provider router (ADR-0015) routes per task with failover to Bedrock / OpenAI / Mistral." "external"
        openai = softwareSystem "OpenAI" "Embeddings for RAG retrieval (text-embedding-3-small, 1536-dim — ADR-0003). Also a failover provider for synthesis / deliverable / agent tasks." "external"
        github = softwareSystem "GitHub" "Repository tarball downloads for repo-link evidence (PAT-authenticated, ADR-0010). PATs encrypted in the AgentCredential vault (ADR-0022)." "external"

        // ─── Co-pilot system ────────────────────────────────────────
        copilot = softwareSystem "Assessment Co-Pilot" "Standardises, accelerates, and drafts consulting assessments while keeping experts accountable for approval." {

            web = container "Next.js Web App" "SSR pages, tRPC API, REST endpoints for upload/download/export, NextAuth credentials auth." "Next.js 15 / TypeScript" {
                ui = component "React UI (App Router)" "Authed pages per engagement tab: engagements, documents, questions, findings, risks, recs, scoring, team-estimate, deliverables, review, export." "React 19 Server + Client Components"
                trpcRouter = component "tRPC Router" "engagement / assessment / document / question / analysis / finding / risk / recommendation / scoring / estimation / deliverable / review / export." "tRPC v11"
                restApi = component "REST API" "Multipart upload, stream download, DOCX export — binary traffic that doesn't fit tRPC." "Next.js Route Handlers"
                nextAuth = component "NextAuth Credentials" "JWT session, bcrypt password hashing, role claim." "NextAuth 4"
                authz = component "Authorization helpers" "engagementAccessFilter / assertEngagementAccess / assertAssessmentAccess (NOT_FOUND-scoped)." "TypeScript"
                services = component "Domain services" "analysis-engine, scoring-service, estimation-service, deliverable-generator, review-manager, question-engine, document-processor, diagram-parser, diagram-generator, export-service, markdown-to-docx, agent/*, template/*, repo/*, settings-service." "TypeScript"
                aiRouter = component "AI router" "callAi(task, ...) — single entry point for every LLM call. Per-task primary + fallback registry, transient-error failover, AI_CALL audit row with cost (ADR-0012 / 0015 / 0016)." "TypeScript"
                prismaClient = component "Prisma client" "All DB access; schema in apps/web/prisma/schema.prisma." "Prisma 6"
                storageClient = component "MinIO / S3 client" "putObject / getObjectBuffer / getObjectStream / deleteObject + auto-bucket bootstrap." "@aws-sdk/client-s3"
                queueEnqueue = component "Queue producer" "enqueueIngestDocument / enqueueIngestDiagram / enqueueIngestArchive / enqueueIngestRepository / enqueueGenerateFollowUps / enqueueRunAnalysis / enqueueRunEstimation / enqueueGenerateDeliverable / enqueueAgentHarness / enqueueProposeTemplateBinding." "BullMQ 5"
            }

            worker = container "BullMQ Worker" "Long-running Node process consuming the document-processing queue. Every AI-heavy job runs here, off the request hot path." "Node.js 20 / TypeScript" {
                workerMain = component "Worker entry" "tsx --env-file=.env src/server/queue/worker.ts. Concurrency 5, lockDuration 10 min." "BullMQ Worker"
                ingestJobs = component "Ingest jobs" "ingest-document (pdf-parse/mammoth → chunk → embedding); ingest-diagram (text parse or vision); ingest-archive (stream-extract + safety gates, ADR-0008); ingest-repository (tarball API → archive pipeline, ADR-0009/0010)." "TypeScript"
                aiJobs = component "AI synthesis jobs" "generate-follow-ups (debounced 1.5s); run-analysis (per-domain fan-out + verifier, ADR-0002/0013); run-estimation; generate-deliverable (diagrams + batched sections)." "TypeScript"
                agentJobs = component "Agent + template jobs" "agent-harness (planner → tool calls → CONNECTOR evidence, ADR-0014/0017); propose-template-binding (customer template → JSON binding, ADR-0018)." "TypeScript"
                housekeeping = component "Housekeeping" "prune-logs (repeatable, every 6h — trims operator `Log` rows past LOG_RETENTION_DAYS)." "TypeScript"
                workerServices = component "Shared domain services" "Imports the same analysis-engine / scoring-service / ... from src/server/services/, plus the AI router." "TypeScript"
            }

            postgres = container "PostgreSQL" "Durable state. pgvector extension enabled for future KB retrieval." "Postgres 16 + pgvector" "database"
            redis = container "Redis" "BullMQ job transport (wait / active / delayed / completed / failed sets). maxRetriesPerRequest=null contract." "Redis 7" "database"
            minio = container "MinIO" "S3-compatible blob storage. Bucket 'assessment-documents' auto-created. Namespaced under assessments/{aid}/documents/{did}/{name}." "MinIO" "database"
            plantuml = container "PlantUML server" "Optional — renders PlantUML diagrams to SVG/PNG. Not on the happy path (we store source code)." "PlantUML (Jetty)"
        }

        // ─── External-facing relationships ──────────────────────────
        consultant -> copilot.web "Uses" "HTTPS"
        reviewer -> copilot.web "Reviews + approves" "HTTPS"
        admin -> copilot.web "Administers" "HTTPS"

        copilot.web -> anthropic "Sync follow-up + workflow-planner calls through the AI router" "HTTPS / JSON"
        copilot.worker -> anthropic "Async AI calls (synthesis, verifier, scoring, deliverable, diagram, estimation, agent planner, template binding) via the router" "HTTPS / JSON"
        copilot.worker -> openai "Embeddings (ingest + query) via the AI router" "HTTPS / JSON"
        copilot.worker -> github "Repo tarball downloads (PAT-authenticated)" "HTTPS"

        // ─── Web container internals ────────────────────────────────
        copilot.web.ui -> copilot.web.trpcRouter "Calls via React Query / httpBatchLink" "superjson"
        copilot.web.ui -> copilot.web.restApi "Uploads / downloads / exports" "multipart / binary"
        copilot.web.trpcRouter -> copilot.web.nextAuth "Resolves session per request"
        copilot.web.trpcRouter -> copilot.web.authz "Gates every procedure"
        copilot.web.trpcRouter -> copilot.web.services "Delegates heavy work"
        copilot.web.trpcRouter -> copilot.web.queueEnqueue "Fires long-running jobs"
        copilot.web.restApi -> copilot.web.authz "Same gates as tRPC"
        copilot.web.restApi -> copilot.web.storageClient "Streams uploads / downloads"
        copilot.web.services -> copilot.web.aiRouter "callAi(task, ...) for follow-up + workflow-planner calls"
        copilot.web.services -> copilot.web.prismaClient "Reads / writes"
        copilot.web.services -> copilot.web.storageClient "Proxies diagram / document bytes"
        copilot.web.queueEnqueue -> copilot.web.restApi "" "(no runtime dep — shown for completeness)"

        // ─── Worker container internals ─────────────────────────────
        copilot.worker.workerMain -> copilot.worker.ingestJobs "Dispatches ingest jobs"
        copilot.worker.workerMain -> copilot.worker.aiJobs "Dispatches synthesis jobs"
        copilot.worker.workerMain -> copilot.worker.agentJobs "Dispatches agent + template jobs"
        copilot.worker.workerMain -> copilot.worker.housekeeping "Runs the repeatable prune-logs job"
        copilot.worker.ingestJobs -> copilot.worker.workerServices "Imports document-processor, diagram-parser, archive-extractor, repo provider."
        copilot.worker.aiJobs -> copilot.worker.workerServices "Imports analysis-engine, scoring-service, estimation-service, deliverable-generator."
        copilot.worker.agentJobs -> copilot.worker.workerServices "Imports agent harness + template fill-and-store."

        // ─── Cross-container relationships ──────────────────────────
        copilot.web -> copilot.postgres "Reads / writes via Prisma" "TCP 5432"
        copilot.web -> copilot.redis "Enqueues jobs" "TCP 6379 / BullMQ"
        copilot.web -> copilot.minio "Puts uploads, streams downloads" "HTTP 9000 / S3 API"

        copilot.worker -> copilot.redis "Dequeues + acks jobs" "TCP 6379 / BullMQ"
        copilot.worker -> copilot.postgres "Reads / writes via Prisma" "TCP 5432"
        copilot.worker -> copilot.minio "Reads uploaded files for processing" "HTTP 9000 / S3 API"

        copilot.worker -> copilot.plantuml "(optional) Render PlantUML source" "HTTP 8081"
    }

    views {
        systemContext copilot "SystemContext" {
            title "System Context — Assessment Co-Pilot"
            include *
            autolayout lr 400 200
        }

        container copilot "Containers" {
            title "Container View — Assessment Co-Pilot"
            include *
            autolayout tb 300 150
        }

        component copilot.web "WebComponents" {
            title "Components — Next.js Web App"
            include *
            autolayout tb
        }

        component copilot.worker "WorkerComponents" {
            title "Components — BullMQ Worker"
            include *
            autolayout tb
        }

        styles {
            element "Person" {
                background "#4a7aff"
                color "#ffffff"
                shape person
            }
            element "external" {
                background "#999999"
                color "#ffffff"
            }
            element "database" {
                shape cylinder
                background "#235e7a"
                color "#ffffff"
            }
            element "Container" {
                background "#438dd5"
                color "#ffffff"
            }
            element "Component" {
                background "#85bbf0"
                color "#000000"
            }
        }

        theme default
    }
}
