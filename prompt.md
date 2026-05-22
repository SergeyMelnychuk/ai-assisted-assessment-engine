You are helping design and start building a product called:

# AI-Powered Assessment Co-Pilot for Discovery, Audit, and Solution Shaping

## 1. Main Idea and Product Vision

We want to build an AI-powered assessment co-pilot for a software development / architecture consulting company.

The purpose of this solution is to standardize, accelerate, and improve early project phases such as:
- discovery
- architecture assessment
- audit preparation
- modernization review
- solution shaping
- implementation readiness assessment
- due diligence / health checks for software platforms

These phases are very common in consulting and software delivery companies. They usually happen before implementation starts, often during pre-sales, proposal preparation, or early engagement stages.

Today, these phases are mostly executed manually by experienced architects, consultants, business analysts, security specialists, and delivery leads. Each time a new RFP, lead, or client opportunity appears, the company repeats a very similar process:
- understand the business and technical context
- gather project and system information
- identify pain points, gaps, and risks
- assess architecture and delivery maturity
- define assumptions and open questions
- propose team composition
- propose indicative effort and pricing
- prepare deliverables such as reports, recommendations, roadmaps, and target-state proposals

This work is valuable, but it is often repetitive, difficult to scale, dependent on senior experts, and inconsistent across engagements.

We want to build a solution that uses AI to support and partially automate this process.

The product must not be positioned as “AI replacing architects” or “AI doing everything alone.”

Instead, the product concept is:

**AI standardizes, accelerates, and drafts the assessment, while experienced experts review, challenge, and approve the parts that require real judgment.**

The goal is to make the delivery model much more scalable:
- if experts today perform 100% of this work manually,
- then with this product they should focus on only the highest-value 25–40%,
- while the AI handles structured intake, evidence collection, analysis support, draft generation, scoring, and initial estimation.

This should improve:
- speed
- repeatability
- consistency
- quality of deliverables
- reusability of organizational knowledge
- scalability of consulting and pre-sales work

---

## 2. Product Goal

Design a system that can support consultants and architects in running discovery and assessment engagements by:
- collecting project information interactively
- analyzing documents and structured inputs
- identifying missing information
- requesting additional evidence and technical access when stakeholder answers are incomplete
- applying predefined review frameworks, heuristics, and templates
- drafting deliverables
- suggesting risks, findings, recommendations, team composition, pricing, and implementation shaping options
- surfacing assumptions, confidence levels, contradictions, and areas requiring expert validation

The system should be usable both:
1. internally by consultants and architects
2. potentially later as a client-facing guided intake and assessment platform

The system must support both:
1. assessment of existing solutions
2. greenfield / startup / new product discovery where there is little or no existing implementation to review

---

## 3. Core Product Positioning

This is an:
- AI-powered assessment co-pilot
- human-in-the-loop consulting accelerator
- structured discovery and solution shaping platform

It is not:
- a fully autonomous architecture consultant
- a black-box estimation engine
- a replacement for accountable experts
- a compliance authority
- a penetration testing tool
- a generic chatbot without domain structure

The product must help experts work faster and more consistently, while preserving human accountability for critical decisions.

---

## 4. Main Problem to Solve

Software delivery and consulting companies repeatedly perform similar early-stage activities for new opportunities and projects:
- RFP analysis
- discovery workshops
- architecture review
- assessment of current state
- review of NFRs
- identification of risks and technical debt
- shaping the solution approach
- estimating required team and effort
- preparing client-facing deliverables

These activities are usually:
- expensive
- slow
- inconsistent
- heavily dependent on senior experts
- hard to standardize
- often not sufficiently reusable from one engagement to another

We want the product to transform this into a structured, AI-assisted workflow.

The product must also address the common reality that clients and stakeholders often cannot answer all questions needed for a reliable assessment. In such situations, the system should escalate from interview-based discovery to evidence-based validation through technical artifacts, approved integrations, and repository/configuration analysis.

---

## 5. Product Principles

The design of the solution must follow these principles.

### 5.1 Human-in-the-loop by design
The system must assume that expert review is essential. It can propose, draft, infer, and analyze, but important outputs should be reviewable, editable, challengeable, and approvable by humans.

### 5.2 Evidence over guessing
The system should always distinguish between:
- facts explicitly provided
- facts inferred from evidence
- assumptions
- missing data
- recommendations based on heuristics

It must avoid presenting assumptions as certainty.

### 5.3 Transparency and traceability
Every major finding, risk, recommendation, or estimate should ideally be traceable to:
- user-provided answers
- uploaded documents
- structured project data
- internal knowledge base rules
- heuristics or scoring models
- evidence connectors and technical artifacts where available

### 5.4 Structured methodology
The solution must be based on reusable, standardized review frameworks, templates, and checklists rather than free-form chat only.

### 5.5 Progressive assessment
The system should not ask everything at once. It should gather information progressively, adapt questions based on previous answers, and focus on what is most relevant for the project type.

### 5.6 Explicit confidence model
The system should express confidence and uncertainty. It should highlight:
- what is well supported
- what is partially supported
- what is unclear
- what requires expert validation

### 5.7 Modular domain coverage
The solution should support multiple review domains such as:
- business context
- product goals
- functional scope
- NFRs
- current architecture
- security and IAM
- integrations and APIs
- cloud and infrastructure
- delivery strategy
- DevOps / SDLC / CI-CD
- test strategy
- observability
- reliability and resilience
- data and analytics
- data distribution strategy
- persistence and storage architecture
- infrastructure maturity and standardization
- support model / operating model
- migration constraints
- delivery risks
- team and governance maturity

### 5.8 Reusable organizational knowledge
The system should leverage a knowledge base containing:
- templates
- checklists
- scoring rules
- sample deliverables
- domain-specific guidance
- team role catalog
- pricing heuristics
- delivery patterns
- risk and recommendation patterns
- technology and platform guidance
- staffing heuristics
- capability discovery models

### 5.9 Output quality suitable for client-facing use
Deliverables must be good enough to become draft client-facing outputs after expert review.

### 5.10 Configurability
The product should allow configuration of:
- assessment types
- assessment modes
- scoring dimensions
- pricing rates
- role catalog
- templates
- report sections
- industry-specific variations
- cloud/platform-specific knowledge
- risk and recommendation libraries
- technology option catalogs
- delivery and staffing heuristics

### 5.11 Evidence escalation principle
If direct answers are incomplete, vague, or unreliable, the system should escalate to requesting and analyzing evidence sources.

### 5.12 Technical truth over declared truth
Where possible, the system should validate claims against technical artifacts rather than relying only on interview responses.

### 5.13 Existing-system and greenfield parity
The product must support both:
- assessment of existing systems
- discovery for new solutions not yet built

These should be first-class modes, not afterthoughts.

### 5.14 Broad delivery readiness perspective
The assessment model must go beyond architecture diagrams and include:
- delivery model
- testing strategy
- data movement
- persistence design
- infrastructure maturity
- operational readiness

### 5.15 Predictability and controllability
A major purpose of the product is to make future implementation more predictable, estimable, and controllable. The outputs should help shape delivery in a way that reduces ambiguity before implementation starts.

---

## 6. High-Level Concept of How the Product Works

The system should support an end-to-end assessment workflow like this.

### Stage 1: Engagement Setup
- create a new assessment / discovery engagement
- define engagement type
- define assessment mode
- define client or opportunity context
- define project type, industry, cloud/platform context, and known constraints
- upload initial documents such as RFP, architecture docs, NFRs, backlog summaries, diagrams, support issues, security requirements, etc.

### Stage 2: Intelligent Intake
- analyze the initial materials
- classify project type and likely relevant domains
- classify whether this is an existing-system assessment or greenfield discovery
- propose initial hypotheses
- identify missing critical information
- generate tailored questions for follow-up

### Stage 3: Interactive Information Collection
- ask structured and adaptive questions
- collect answers from consultants and/or client representatives
- request evidence or supporting materials where needed
- identify inconsistencies or incomplete areas
- explain why certain missing information matters
- request additional access to technical artifacts if direct answers are insufficient
- refine the understanding iteratively

### Stage 4: Evidence Validation and Technical Analysis
- ingest and analyze approved technical artifacts and connected evidence sources
- validate stakeholder-stated facts against technical evidence
- detect contradictions and unresolved discrepancies
- extract evidence from repositories, configurations, infrastructure definitions, and operational artifacts
- convert evidence into structured assessment signals

### Stage 5: Analysis and Assessment
- map inputs to predefined review frameworks
- assess maturity by domain
- identify risks, gaps, dependencies, and assumptions
- propose opportunities and recommendations
- flag areas needing expert intervention

### Stage 6: Solution Shaping
- propose likely solution directions
- suggest target-state themes
- propose possible implementation workstreams
- identify required expertise
- propose team composition and responsibilities
- in greenfield mode, define what should exist rather than only assessing what already exists

### Stage 7: Estimation and Commercial Drafting
- estimate indicative effort ranges
- calculate price using configurable rates and effort assumptions
- explain estimation logic
- provide team mix rationale
- support scenario-based staffing and cost options

### Stage 8: Deliverable Generation
Draft outputs such as:
- executive summary
- discovery or assessment report
- findings and recommendations
- risk register
- target-state architecture draft
- roadmap / next steps
- assumptions and open questions
- team composition
- indicative cost estimate / ROM
- optional SOW / proposal draft
- greenfield capability outline and technology/platform recommendations where relevant

### Stage 9: Expert Review and Finalization
- allow experts to review, edit, reject, refine, and approve outputs
- maintain clear distinction between AI draft and approved final content
- preserve traceability between outputs and evidence

---

## 7. Assessment Modes

The system should support multiple first-class assessment modes.

### 7.1 Existing Solution Assessment
Used when there is an existing platform, application, product, or delivery setup to review.

Typical goals:
- understand current state
- identify risks and gaps
- assess maturity
- propose improvements or modernization direction
- estimate implementation effort and team needed for change

### 7.2 Modernization Assessment
Used when the existing solution is being transformed, decomposed, migrated, or upgraded.

Typical goals:
- understand migration constraints
- assess readiness
- identify transition risks
- shape modernization workstreams

### 7.3 Audit / Readiness Assessment
Used when the client wants structured readiness insight before implementation, scale-up, platform changes, compliance work, or operational hardening.

### 7.4 Pre-Implementation Solution Shaping
Used before implementation to clarify scope, architecture direction, delivery setup, staffing, and estimate.

### 7.5 Greenfield / Startup Discovery
Used when there is little or no existing solution.

Typical goals:
- clarify product vision
- define capabilities needed for MVP and later phases
- recommend architecture and platform direction
- recommend technology options
- propose team composition
- provide phased roadmap and ROM estimate

The system must treat greenfield discovery as a core use case, not as a variation of existing-system review.

---

## 8. What the Product Should Be Able to Assess

The system should support multiple engagement types, for example:
- discovery phase before implementation
- architecture assessment of an existing solution
- cloud readiness review
- modernization assessment
- solution shaping before proposal
- audit readiness assessment
- delivery maturity assessment
- security / IAM readiness assessment
- API/integration assessment
- reliability / resilience review
- cost / operational maturity review
- greenfield / startup product discovery
- MVP planning and launch preparation

The system should be extensible so new assessment types can be added later.

It should also support a broader set of review domains.

### 8.1 Delivery strategy assessment
The product should be able to assess delivery strategy, including:
- team topology and delivery ownership
- release model
- deployment strategy
- branching and versioning strategy
- governance and approval flow
- sprint/release predictability
- dependency management across teams
- environment promotion model
- change management maturity
- rollout and rollback approach
- operational readiness for releases

The system should identify:
- bottlenecks
- risk areas
- missing controls
- over-manualized delivery
- insufficient automation
- unclear ownership
- unsuitable release governance

### 8.2 Test strategy assessment
The product should be able to assess test strategy in depth, including:
- test pyramid / testing model
- unit / integration / contract / end-to-end testing
- regression strategy
- performance testing
- security testing
- test automation maturity
- test environments
- test data management
- coverage visibility
- CI/CD test gates
- release confidence model
- production validation and post-release testing

The output should help determine:
- whether the current strategy is sufficient
- which gaps increase delivery risk
- what test capabilities are required for future delivery
- what roles and expertise are needed

### 8.3 Data distribution strategy assessment
The product should be able to assess data distribution strategy, including:
- how data moves between systems
- integration styles
- synchronization model
- event-driven vs request-response patterns
- batch vs streaming mechanisms
- ownership of data domains
- data consistency expectations
- replication and duplication patterns
- reporting and analytics data flows
- cross-system dependencies
- latency expectations
- eventual consistency acceptance
- data reconciliation mechanisms
- failure handling and recovery
- data lineage awareness

This area should be treated as a first-class review domain, especially for distributed systems, integration-heavy products, and modernization programs.

### 8.4 Persistent storage review
The product should support a detailed review of persistent storage and data persistence design.

This should include:
- types of datastores in use
- storage ownership by domain/service
- coupling between services and shared data
- transactional boundaries
- migration complexity
- schema management
- partitioning and scalability model
- backup and restore capabilities
- retention and archival policies
- multi-region / DR considerations
- data access patterns
- performance bottlenecks
- storage technology suitability
- operational maturity of storage management
- security controls around data
- sensitivity and classification of stored data where relevant

### 8.5 Infrastructure maturity and standardization assessment
The product should assess infrastructure maturity in terms of how infrastructure is:
- standardized
- templated
- reusable
- governed
- scalable
- supportable

This must apply to both:
- cloud environments
- on-premise environments
- hybrid environments

The review should consider:
- infrastructure-as-code maturity
- use of reusable modules/templates
- consistency across environments
- naming/tagging standards
- network patterns
- environment provisioning approach
- secrets/configuration management
- platform baselines
- patching and maintenance approach
- observability integration
- disaster recovery and resilience setup
- policy enforcement
- drift management
- golden paths / platform engineering maturity
- self-service vs manual provisioning
- standardization of runtime platforms
- reusability of infrastructure patterns

The solution should be able to distinguish between:
- ad hoc infrastructure
- partially standardized infrastructure
- mature reusable platform foundations

---

## 9. Types of Inputs the Product Should Support

The system should support both structured and unstructured inputs.

### Structured inputs
- project metadata
- client name
- industry
- engagement type
- assessment mode
- business goals
- expected timelines
- scope areas
- NFR entries
- cloud/platform details
- existing team structure
- known pain points
- known constraints
- estimated user loads / transaction volumes
- security/compliance requirements
- budget sensitivity
- target delivery model

### Unstructured inputs
- RFPs
- requirement documents
- architecture overviews
- current-state diagrams
- API specs
- backlog exports / epics
- meeting notes
- incident summaries
- observability snapshots
- security documentation
- operational manuals
- support documents
- migration notes
- proposal documents from previous phases

### Connected or validated evidence sources
The system should also be designed to request or ingest approved technical artifacts and access integrations such as:
- source code repositories
- infrastructure-as-code repositories
- CI/CD pipelines and workflow definitions
- cloud configurations and inventories
- Kubernetes manifests / Helm charts
- Terraform / Bicep / CloudFormation / Pulumi
- API gateway configuration
- monitoring and observability dashboards
- log and metric samples
- test repositories and test reports
- database schemas and migration scripts
- architecture decision records
- backlog / ticketing systems
- security policies and IAM configurations
- environment topology and deployment configuration
- dependency manifests
- on-premise infrastructure configuration exports where available

The system must be designed to ingest and analyze uploaded documents and connected evidence, and map them into structured assessment dimensions.

---

## 10. Main Deliverables the Product Should Generate

The system should be capable of drafting the following outputs.

### 10.1 Executive Summary
- what the project is about
- current context
- key challenges
- high-level findings
- recommended direction
- delivery implications

### 10.2 Assessment / Discovery Report
- engagement purpose
- scope and assumptions
- current-state summary
- findings by domain
- strengths
- weaknesses
- gaps
- major observations
- recommendations
- open questions
- contradictions or validation notes where relevant

### 10.3 Risk Register
- risk title
- category
- description
- evidence
- impact
- likelihood
- severity / priority
- mitigation proposal
- owner suggestion
- confidence level

### 10.4 Target-State Draft
- target architecture direction
- major design principles
- workstreams
- possible transition states
- key constraints and dependencies

### 10.5 Roadmap
- 30/60/90-day style roadmap or phased roadmap
- quick wins
- foundational work
- sequencing guidance
- optional dependencies and milestones

### 10.6 Team Composition Proposal
- roles needed
- required expertise
- why each role is needed
- approximate level/seniority
- responsibilities by role
- possible phased staffing approach

### 10.7 Indicative Estimate / Pricing Proposal
- effort ranges
- role allocation
- assumptions behind estimate
- hourly/daily rates from configurable rate card
- price summary
- optional scenario-based estimates

### 10.8 Assumptions, Gaps, and Questions
- explicitly list missing data
- explain how missing data affects confidence and estimates
- identify what must be clarified before implementation starts

### 10.9 Optional Statement of Work / Proposal Draft
- scope
- objectives
- proposed engagement steps
- deliverables
- effort
- team
- assumptions
- exclusions

### 10.10 Greenfield discovery outputs
For greenfield/startup/new-product discovery, the product should also support:
- discovery summary
- product capability breakdown
- target capability outline
- initial architecture direction
- technology option matrix
- platform recommendation
- MVP scope recommendation
- phased delivery roadmap
- staffing model
- indicative budget / ROM estimate
- risks and assumptions
- readiness gaps before implementation start
- initial build plan

---

## 11. Expected Product Capabilities

Please design the system with the following capabilities in mind.

### 11.1 Assessment orchestration
A workflow engine that manages the lifecycle of an assessment.

### 11.2 Adaptive questioning
A question engine that can:
- generate follow-up questions
- choose next best questions
- detect missing information
- vary questions by assessment type, assessment mode, and domain

### 11.3 Knowledge-base-driven reasoning
A knowledge model that uses:
- templates
- checklists
- domain heuristics
- best practices
- scoring models
- recommendation libraries
- risk libraries
- technology guidance
- staffing and pricing rules

### 11.4 Document analysis and evidence extraction
Ability to process uploaded materials and extract relevant context, facts, concerns, and signals.

### 11.5 Evidence-source integration layer
A subsystem that can connect to or ingest from:
- code repositories
- IaC repositories
- CI/CD systems
- cloud metadata/configuration exports
- observability artifacts
- database schema exports
- test reports
- backlog systems
- documentation systems

### 11.6 Validation workflow
The ability to:
- compare stakeholder claims with artifact evidence
- detect contradictions
- record unresolved discrepancies
- flag claims that require expert review

### 11.7 Scoring and maturity model
A configurable way to score domains and summarize maturity.

### 11.8 Findings and risk generation
Ability to propose findings, risks, and recommendations with confidence and evidence references.

### 11.9 Team and pricing engine
A configurable engine that suggests:
- expert roles
- effort ranges
- pricing
- rationale
- assumptions

### 11.10 Deliverable generation engine
Ability to assemble structured outputs using templates and approved content blocks.

### 11.11 Expert review workflow
Support for:
- reviewing drafts
- editing outputs
- approving sections
- overriding AI suggestions
- tracking approved vs draft status

### 11.12 Auditability
Keep records of:
- inputs
- questions asked
- answers given
- evidence used
- validation decisions
- generated findings
- human edits
- approvals

---

## 12. Non-Functional Expectations for the Product

Design the solution with these qualities in mind:
- modular architecture
- extensibility
- maintainability
- traceability
- explainability
- security by design
- role-based access
- multi-tenant potential
- support for confidential project data
- versioned templates and knowledge artifacts
- support for iterative refinement
- ability to export deliverables
- support for human approvals
- support for configurable pricing and roles
- support for multiple industries and engagement types later
- auditable access to connected evidence sources
- explicit permissions and access control for integrations

---

## 13. Human Roles in the System

The product should recognize different user roles, for example:
- architect
- consultant
- business analyst
- security expert
- delivery lead
- sales / pre-sales user
- reviewer / approver
- admin / knowledge manager

The system should support workflows where:
- one person runs intake
- another reviews risks
- an architect approves recommendations
- a delivery lead validates team composition and estimate
- a knowledge manager updates templates, checklists, role catalog, and rates

---

## 14. Knowledge Base Requirements

Please design a knowledge architecture for the solution.

We need a reusable knowledge base that can store and evolve:
- assessment frameworks
- engagement playbooks
- checklists by domain
- heuristics and scoring logic
- prompt templates
- risk patterns
- recommendation patterns
- target-state patterns
- role catalogs
- rate cards
- team composition heuristics
- deliverable templates
- sample outputs
- industry-specific overlays
- cloud/platform-specific overlays
- terminology and glossary
- technology option catalogs
- platform recommendation guidance
- capability discovery models
- validation rules for artifact-backed evidence

The knowledge base should be versioned and maintainable. It should be possible to update knowledge without rewriting the whole application.

---

## 15. Desired Product Behavior

The system must behave like a professional assessment co-pilot.

It should:
- be structured, methodical, and explicit
- not jump to unsupported conclusions
- ask relevant questions
- highlight ambiguity
- adapt by engagement context
- distinguish between low-confidence and high-confidence observations
- avoid hallucinated certainty
- prefer evidence-backed drafting
- surface review-required areas clearly
- explain why certain roles or expertise are recommended
- explain why certain cost or effort assumptions were made
- request additional evidence when direct answers are insufficient
- clearly distinguish stakeholder-stated facts, evidence-validated facts, and unresolved contradictions

---

## 16. Things the System Must Avoid

The system must avoid:
- pretending to know missing facts
- making hidden assumptions without surfacing them
- overconfident estimates without clear basis
- producing polished but shallow reports
- replacing human accountability in critical decisions
- black-box pricing recommendations
- generic outputs detached from the evidence collected
- one-size-fits-all questionnaires that ignore project context
- forcing rigid process when information is incomplete or uncertain
- unrestricted autonomous access to customer systems or repositories

---

## 17. MVP Philosophy

The first version should be practical and focused.

The MVP does not need to solve everything. Instead, it should prove the value of the concept in a realistic internal workflow.

A strong MVP would likely focus on:
- one or two assessment types
- structured intake
- document upload and analysis
- adaptive questioning
- draft report generation
- draft risk register
- draft team composition
- draft ROM estimate
- expert review workflow
- exportable outputs

The MVP should be good enough to demonstrate that expert effort can be reduced significantly while maintaining quality and accountability.

---

## 18. Suggested Initial Assessment Types for MVP

For MVP, prioritize one or two of:
- architecture assessment / solution review
- discovery before implementation
- modernization assessment
- audit / readiness review

Choose the most reusable internal scenario.

Also state whether the following belong in MVP, MVP+1, or later phases, and explain the trade-offs:
- evidence-source integrations
- delivery strategy assessment
- test strategy assessment
- data distribution assessment
- storage assessment
- infrastructure maturity assessment
- greenfield/startup discovery mode

---

## 19. What I Want You to Produce

Please act as a senior product architect and engineering lead.

Based on everything above, design the solution in detail and produce the following.

### A. Product definition
- concise product description
- target users
- main use cases
- core value proposition
- boundaries and non-goals

### B. Functional architecture
- major modules / services
- responsibilities of each module
- key workflows
- integration points
- knowledge-base strategy
- orchestration approach
- human review flow

### C. Domain model
Define the main entities and their relationships, including at least:
- Assessment
- Engagement
- AssessmentType
- AssessmentMode
- ProjectContext
- Document
- Evidence
- EvidenceSource
- RepositoryConnection
- ArtifactValidation
- Question
- Answer
- DomainScore
- Finding
- Risk
- Recommendation
- Assumption
- RoleProposal
- Estimate
- RateCard
- Deliverable
- Review
- Approval
- KnowledgeArtifact
- Template
- HeuristicRule
- TechnologyOption
- PlatformRecommendation
- CapabilityMap
- DeliveryStrategyAssessment
- TestStrategyAssessment
- DataDistributionAssessment
- StorageAssessment
- InfrastructureMaturityAssessment

### D. Data flow
Describe the flow from:
input documents and answers
→ evidence extraction
→ structured assessment state
→ validation against connected artifacts
→ findings / scoring / recommendations
→ team and pricing proposal
→ deliverable generation
→ review and approval

### E. AI design
Describe how AI should be used in the product, including:
- where LLMs are used
- where deterministic rules are preferred
- how prompting should work
- how retrieval from knowledge base should work
- how confidence / uncertainty should be handled
- how expert review checkpoints should be enforced

### F. Knowledge model
Design the structure of the knowledge base:
- frameworks
- rules
- templates
- risk patterns
- recommendation patterns
- pricing rules
- staffing heuristics
- domain-specific overlays
- technology option guidance
- platform recommendation guidance

### G. UX / workflow design
Describe the main product workflow from a user perspective:
- create engagement
- select assessment mode
- upload materials
- AI summarizes context
- AI asks follow-up questions
- user answers / uploads more evidence
- AI requests technical artifact access if needed
- AI drafts findings and deliverables
- experts review and approve
- export outputs

### H. Assessment modes
Clearly separate how the system behaves in:
- existing-system assessment
- greenfield discovery

### I. Evidence validation
Describe how the system requests, ingests, and uses technical artifacts when answers are incomplete.

### J. Expanded domain coverage
Describe how delivery, testing, data distribution, persistence, and infrastructure maturity are modeled and assessed.

### K. Greenfield/startup workflow
Describe how the product helps shape a new product or platform when there is no existing implementation to assess.

### L. MVP scope
Propose a realistic MVP:
- what to include
- what not to include yet
- what assumptions to make
- what can be mocked or simplified

### M. Technical implementation approach
Propose a technical architecture and implementation approach, for example:
- frontend
- backend
- workflow orchestration
- storage
- knowledge store
- vector search if needed
- template rendering
- document ingestion pipeline
- auth and RBAC
- export generation
- audit trail

You may choose a stack, but explain why.

### N. Repo and project structure
Propose a clean monorepo or multi-repo structure for implementation.

### O. Delivery roadmap
Propose phased implementation steps:
- Phase 0: design and knowledge modeling
- Phase 1: MVP foundations
- Phase 2: intelligent intake and assessment engine
- Phase 3: estimation and deliverable generation
- Phase 4: review, approval, and hardening

### P. Risks and design cautions
List the main risks in building this product and how to address them.

### Q. Initial backlog
Produce an initial backlog of epics and key user stories.

---

## 20. Important Design Guidance

When designing this product, keep these truths central:
- the product is built around standardization and acceleration, not total autonomy
- the best outcome is AI-assisted consulting, not replacing senior architects
- human review is a feature, not a fallback
- confidence, traceability, and explicit assumptions are essential
- estimation and team composition must be explainable
- the system must make consulting knowledge reusable and operational
- the system should reduce repetitive effort while keeping expert judgment where it matters most

---

## 21. Output Style Requirements

Your response should be:
- highly structured
- implementation-oriented
- explicit and concrete
- realistic, not futuristic marketing language
- suitable as a foundation for actual product design and engineering work

Where useful, include:
- diagrams in text form
- module lists
- step-by-step flows
- sample entity definitions
- suggested APIs
- suggested folder structure
- suggested milestones

---

## 22. Final Framing Statement

This product is not only an AI-assisted review engine for existing systems.

It is a broader AI-powered discovery, assessment, and solution-shaping co-pilot that can:
- assess current systems
- validate technical reality through artifacts
- identify gaps and risks
- shape future solutions
- help define team, cost, architecture, and delivery approach for both existing and brand-new products

The goal is to make the earliest and most uncertain phases of software delivery:
- more structured
- more evidence-based
- more repeatable
- more scalable
- and more predictable

---

After providing the design, start proposing:
1. a concrete MVP architecture
2. a recommended tech stack
3. a repo structure
4. initial domain models
5. and the first implementation tasks in execution order