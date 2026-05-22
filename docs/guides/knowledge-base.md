# Knowledge Base Guide

This guide is for **Knowledge Managers** (who edit KB content) and
**consultants / reviewers** (who see how that content shows up during
an engagement). It covers what's in the Knowledge Base, how each
artifact gets used during an assessment, and how to add or change
content safely.

---

## What the Knowledge Base is

A set of **JSON files** under `packages/knowledge-seed/` that get
loaded into the Postgres `KnowledgeArtifact` table and read by the
AI tasks at assessment-run time.

There are **two ways content gets in or changes**:

1. **Seed** (`pnpm db:seed`) — reads every JSON file under
   `packages/knowledge-seed/` and upserts it into the matching DB
   table. This is the canonical, git-versioned, PR-reviewable path.
   It's how content lands on a fresh install and how committed
   changes propagate after a re-seed.
2. **Admin UI** at `/admin/knowledge-base` — for ad-hoc edits to a
   running deployment. You can create, edit, toggle `isActive`, and
   change the JSON content of any artifact without touching the
   filesystem.

**Important precedence rule:** the seed *upserts* on
`(artifactType, name)`, so **`pnpm db:seed` overwrites runtime admin
edits** if the JSON file has the same artifact. Treat the admin UI
as a "live tweak while we're iterating" surface, and the JSON files
as the source of truth — once you're happy with an edit, commit it
to the corresponding file so the next re-seed preserves it.

```
packages/knowledge-seed/
├── frameworks/              ← scoring rubrics (5-level maturity)
├── question-templates/      ← per-domain question packs
├── risk-patterns/           ← canonical risks + recognition cues
├── role-catalog/            ← consulting roles + seniority ranges
├── rate-cards/              ← billing rates (see /admin/rate-cards)
├── estimation-templates/    ← WBS workbook + binding (see Templates guide)
└── deliverable-shells/      ← 10 docx/pptx/xlsx shells + bindings (see Templates guide)
```

> **What this guide covers.** Everything that lands in the
> `KnowledgeArtifact` table and shows up on `/admin/knowledge-base` —
> that's 14 artifact types in total. Today **4 are actively read by
> the AI tasks** (frameworks, question templates, risk patterns, role
> catalog); the other 10 are **reserved types** (defined in the enum
> and surfaced in the admin UI, but no service reads them yet — they
> exist as scaffolding for future pipeline stages). Both groups are
> covered below.
>
> The other three folders in the seed map above (rate cards,
> estimation templates, deliverable shells) live in their own tables
> (`RateCard` and `Template`) with their own admin surfaces. They're
> listed in the map because they share the `packages/knowledge-seed/`
> root, but they're documented elsewhere:
>
> - **Rate cards** — managed at `/admin/rate-cards`, no separate guide today.
> - **Estimation workbook + deliverable shells** — see
>   [`templates.md`](./templates.md).

### The 14 types at a glance

| Type | Status | Read by | Seed file? |
|---|---|---|---|
| Frameworks | **Active** | `analysis.synthesis`, `analysis.scoring` | Yes |
| Question templates | **Active** | Baseline question seeding + `analysis.synthesis` prompt context | Yes |
| Risk patterns | **Active** | `analysis.synthesis` prompt context | Yes |
| Role catalogs | **Active** | `estimation` task | Yes |
| Recommendation patterns | Reserved | — | No |
| Checklists | Reserved | — | No |
| Report templates *(KB row, not the workspace `Template` table)* | Reserved | — | No |
| Heuristics | Reserved | — | No |
| Technology options | Reserved | — | No |
| Platform guidance | Reserved | — | No |
| Capability models | Reserved | — | No |
| Scoring models | Reserved | — | No |
| Industry overlays | Reserved | — | No |
| Cloud overlays | Reserved | — | No |

"Reserved" means: you can create, edit, and toggle these rows from
`/admin/knowledge-base` and they will persist — but no current AI task
or service queries the `KnowledgeArtifact` table for them. Adding rows
won't change any output until the corresponding pipeline stage is
wired up. Don't put load-bearing content there yet.

---

## How questions get assigned per assessment

This is the most asked question, so it goes first.

**Each `Assessment` has an `activeDomains` array.** It's set at
assessment creation (defaults come from the chosen `AssessmentType`),
and it stays editable from Setup. The picker is sourced from the list
of domains the active framework defines.

When questions get seeded for an assessment:

1. The seed reader looks at `assessment.activeDomains` — say,
   `["business_context", "architecture", "security_iam"]`.
2. It loads the matching `question-templates/<domain>.json` files
   from the KB. Files for non-active domains are **skipped**.
3. Each question in those files becomes a `Question` row, with
   `generatedBy = "TEMPLATE"`.
4. The seed is **idempotent per domain**: if a domain already has
   template-sourced questions for this assessment, it's skipped on
   re-run. So adding a new active domain later seeds only the new
   domain's questions without duplicating the old ones.

```
Assessment.activeDomains          question-templates/*.json
   ["business_context",  ─────▶   business_context.json   ─┐
    "architecture",                architecture.json        ├─▶  Question rows
    "security_iam"]                security_iam.json       ─┘     (generatedBy=TEMPLATE)
                          (skipped: nfrs.json, devops_cicd.json, …)
```

**Follow-up questions** (`followups.generate` AI task) are layered on
top. After a user answers a baseline question, the AI may generate
adaptive follow-ups — these land as `Question` rows with
`generatedBy = "AI"`. They're stamped with a `domain` so they show
up under the right tab. Follow-ups are debounced (~1.5 s) so a burst
of answers doesn't fire ten parallel calls.

**Priority** on a question (`CRITICAL` / `HIGH` / `MEDIUM` / `LOW`)
controls sort order in the UI. It's metadata only — the AI doesn't
gate on it.

---

## Artifact families — what each does

### 1. Frameworks (`frameworks/*.json`)

A framework is the **scoring rubric** for an assessment. One file per
assessment type. The framework declares which domains exist for that
type, their weights, and the 1–5 maturity criteria for each domain.

```json
{
  "name": "Architecture Assessment Framework",
  "applicableTo": {
    "assessmentTypes": ["architecture_assessment", "modernization_assessment"],
    "assessmentModes": ["EXISTING_SYSTEM", "MODERNIZATION"]
  },
  "domains": [
    {
      "key": "security_iam",
      "name": "Security & IAM",
      "weight": 0.15,
      "scoringCriteria": [
        { "level": 1, "description": "No formal IAM; ad hoc credentials" },
        { "level": 2, "description": "Basic auth in place, gaps in MFA/SSO" },
        { "level": 3, "description": "SSO + MFA on critical paths" },
        { "level": 4, "description": "Centralised IAM with regular reviews" },
        { "level": 5, "description": "Zero-trust posture with continuous validation" }
      ]
    }
  ]
}
```

**Where it shows up in the engagement:**

- **At assessment creation:** the framework's domains become the
  default `activeDomains` set; the consultant trims or extends.
- **During analysis (`analysis.scoring` AI task):** the rubric
  anchors are loaded for every active domain and put into the prompt.
  The AI must pick a 1–5 score with reasoning grounded in those
  anchors, *not* free-form judgment.
- **In deliverables:** the rubric text shows up alongside the score
  in the assessment report so the reader sees what "Level 3" actually
  means for this domain.

**Adding a new framework:** drop a new file in `frameworks/`, set
`applicableTo.assessmentTypes` to match an existing `AssessmentType`
row, and re-seed.

---

### 2. Question templates (`question-templates/*.json`)

One file per domain. Each file lists the **baseline questions** that
get seeded into an assessment when that domain is active.

```json
{
  "domain": "security_iam",
  "name": "questions.security_iam.baseline",
  "questions": [
    {
      "text": "What is the primary user-authentication mechanism?",
      "type": "SINGLE_CHOICE",
      "options": [
        "Username/password only",
        "Federated SSO (SAML/OIDC)",
        "MFA-enforced SSO",
        "Passwordless / WebAuthn",
        "Bespoke / other"
      ],
      "priority": "CRITICAL",
      "rationale": "Authentication floor determines the ceiling for almost every other IAM control."
    }
  ]
}
```

**Where it shows up:**

- **Questions tab** of an assessment — grouped by domain, sorted by
  priority.
- **AI synthesis (`analysis.synthesis`):** answered questions are
  pulled into the prompt as factual context. The AI uses them to back
  up findings ("Based on the answer to 'What is the primary
  authentication mechanism?', the system relies on
  username/password only, exposing it to credential-stuffing
  risk…").
- **Coverage view:** the Questions page shows what % of each domain
  has been answered.

**Question types currently supported:** `SINGLE_CHOICE` (with
`options`), `FREE_TEXT`. Field-level: `text` (required), `type`,
`priority`, `rationale` (shown as a tooltip in the UI), `options`
(only for `SINGLE_CHOICE`).

**Adding a question pack for a new domain:** create
`question-templates/<domain_key>.json`. The `domain` field at the top
must match a domain `key` defined in a framework's `domains[]`. Add
the domain key to the relevant `AssessmentType.defaultDomains` if you
want it active by default.

---

### 3. Risk patterns (`risk-patterns/*.json`)

A library of **canonical risks** the AI can pattern-match against.
Each pattern has trigger conditions (so the AI can identify when it
applies) and a templated risk row.

```json
{
  "patterns": [
    {
      "id": "risk-arch-001",
      "title": "Monolithic architecture scaling limitations",
      "domain": "architecture",
      "triggerConditions": ["architecture_style == monolith", "expected_growth > moderate"],
      "riskTemplate": {
        "title": "Scalability constraints due to monolithic architecture",
        "category": "Architecture",
        "description": "The current monolithic architecture may not support expected growth …",
        "impact": "HIGH",
        "likelihood": "LIKELY",
        "mitigationProposal": "Consider a phased decomposition strategy…"
      },
      "confidenceBase": 0.7
    }
  ]
}
```

**Where it shows up:**

- **AI synthesis (`analysis.synthesis`):** the catalog is included
  in the prompt so risk output references known patterns instead of
  inventing risk language. When the AI emits a risk, the impact /
  likelihood / mitigation pull from the template.
- **Risks tab + risk register deliverable:** the emitted `Risk` rows
  appear with the templated `category`, `impact`, `likelihood`.

**`triggerConditions`** is documentation for the AI prompt — not a
rules engine. Format is free-form text the AI uses to decide whether
the pattern fits. Keep it pithy.

**Adding a new risk pattern:** append to an existing
`risk-patterns/*.json`. `id` must be unique; pick a prefix
(`risk-arch-`, `risk-security-`, …) and pad to three digits.

---

### 4. Role catalog (`role-catalog/standard-roles.json`)

Single file. Defines the **menu of roles** the estimation AI can
propose. The AI can't invent roles — it picks from this list.

```json
{
  "roles": [
    {
      "key": "solution_architect",
      "name": "Solution Architect",
      "seniorityRange": ["SENIOR", "LEAD", "PRINCIPAL"],
      "description": "Defines overall architecture direction, makes key technology decisions, ensures alignment with business goals",
      "typicalResponsibilities": [
        "Architecture design and documentation",
        "Technology selection and evaluation",
        "Architecture review and governance"
      ],
      "whenNeeded": "Always needed for any non-trivial project"
    }
  ]
}
```

**Where it shows up:**

- **Team & Estimate** workflow step: the AI (`estimation` task)
  proposes a team mix using *only* roles from this catalog. For each
  proposed role, it picks a seniority from `seniorityRange` and an
  hour count.
- **Team proposal deliverable:** the proposed roles appear with
  `description` and `typicalResponsibilities` for the reader's
  benefit.

**Adding a role:** append to the `roles[]` array. Make sure the role
also has matching rows in the rate card (managed separately at
`/admin/rate-cards`) for at least one seniority in `seniorityRange`,
otherwise pricing fails at fill time (soft-failure: estimation still
completes, the price column shows as empty).

> **Rate cards are not covered in this guide.** They live in their
> own `RateCard` table (not in `KnowledgeArtifact` like everything
> else here) and are managed at `/admin/rate-cards` in the running
> app. The seed file at
> `packages/knowledge-seed/rate-cards/default-rate-card.json`
> populates that table on `pnpm db:seed`, but day-to-day rate
> management goes through the admin UI.

---

### 5. Reserved types (scaffolded, not yet wired)

The remaining 10 types appear on `/admin/knowledge-base` and you can
create rows for them, but **no AI task or service currently reads
them**. They were added to the enum and UI to reserve the shape for
future pipeline stages — so the admin surface, the JSON-content
editor, and the `isActive` toggle are all in place, ready for the
day the corresponding consumer lands.

Until then, treat them as drafting scratchpads. Putting content here
won't change findings, risks, scores, estimates, or deliverables.

| Type | Intended purpose (when wired) |
|---|---|
| **Recommendation patterns** | Canonical recommendation library, paired with `risk-patterns/`. Intended to anchor `analysis.synthesis` recommendation output the same way risk patterns anchor risks today (templated title / category / effort / impact). |
| **Checklists** | Structured walk-throughs for specific review scenarios (e.g. "Production-readiness checklist", "Pre-migration sign-off"). Intended to drive a checklist-style assessment surface separate from the maturity-rubric framework. |
| **Report templates** *(KB row, not the workspace `Template` table)* | Section/structure outlines for deliverables — a KB-resident skeleton that the `deliverable.section` task could consult before filling a workspace `Template` file. Distinct from the docx/pptx/xlsx shells in `/admin/templates`, which contain the actual binary file + binding. |
| **Heuristics** | Short "rules of thumb" injected into AI prompts as terse guidance ("prefer managed services over self-hosted unless cost > X", "treat any answer of 'we don't know' on auth as a CRITICAL risk"). Intended to sharpen prompt output without retraining. |
| **Technology options** | Known-good tech choices with trade-offs ("Postgres vs DynamoDB for OLTP", "EKS vs ECS for container orchestration"). Intended to back a recommendation-set picker so the AI proposes from a curated menu rather than free-form. |
| **Platform guidance** | Cloud/platform best practices that aren't AWS/Azure/GCP-specific (e.g. generic "managed Kubernetes posture", "serverless cold-start mitigations"). Intended as additional prompt context for relevant domains. |
| **Capability models** | Domain capability maps — used during **greenfield** discoveries to enumerate what capabilities a target solution needs (e.g. "Identity → SSO, MFA, lifecycle, audit"). Intended to scaffold greenfield discovery output before any current-state evidence exists. |
| **Scoring models** | Alternate scoring rubrics beyond the standard framework rubric — e.g. a CMMI-style ladder, a custom client-specific scale. Intended to let an engagement opt into a non-default scoring rubric without forking the framework JSON. |
| **Industry overlays** | Industry-specific question/risk adjustments layered on top of the baseline (e.g. healthcare-HIPAA, fintech-PCI, public-sector-FedRAMP). Intended to bias the AI prompt toward the regulatory context of the engagement. |
| **Cloud overlays** | Provider-specific overrides — AWS / Azure / GCP flavours of risk patterns, recommendations, technology options. Intended so a generic risk like "secrets management" maps to "use AWS Secrets Manager" vs "Azure Key Vault" at synthesis time. |

**If you want to start drafting content for one of these.** Open
`/admin/knowledge-base`, pick the type, click *New artifact*, and
write the JSON. The shape is up to you — there's no Zod validator
behind these yet because no consumer exists. When the consumer lands,
it will define the expected schema and may need to migrate existing
rows. So: by all means experiment, but don't bake critical content in
here yet.

---

### Estimation workbook and deliverable shells — see the Templates guide

`estimation-templates/` and `deliverable-shells/` are **not**
`KnowledgeArtifact` rows and do not appear on `/admin/knowledge-base`.
They live in the `Template` table with their own admin surface
(workspace defaults at `/admin/templates`; engagement-scoped
customer uploads under the Templates tab on each engagement).

See [`templates.md`](./templates.md) for the full guide:
what the workbook + shells contain, how the binding JSON maps
engine outputs into cells / placeholders, how to upload customer
templates, the approval lifecycle, and the soft-failure semantics
when a binding is broken.

---

## End-to-end: how all of this composes during an assessment

```
1. Create engagement → create assessment → pick AssessmentType
       │
       ▼
2. activeDomains seeded from AssessmentType defaults
       │     (consultant can edit in Setup)
       ▼
3. seedBaselineQuestions(assessment)
       │   loads question-templates/{domain}.json for each active domain
       │   inserts Question rows (generatedBy=TEMPLATE)
       ▼
4. Consultant uploads documents / links repos → Evidence rows
   Consultant answers baseline questions → Answer rows
       │     followups.generate may emit more Questions (generatedBy=AI)
       ▼
5. "Run analysis" button → per-domain fan-out
       │   For each active domain:
       │     • retrieve top-K Evidence chunks
       │     • build prompt with:
       │         - framework rubric (domain weight + 5-level criteria)
       │         - risk-patterns catalog
       │         - question/answer pairs for this domain
       │         - retrieved chunks
       │     • analysis.synthesis → Finding/Risk/Recommendation rows
       │     • analysis.scoring   → DomainScore (1-5, anchored to rubric)
       ▼
6. "Run estimation" → role catalog as menu, AI proposes hours/role
       │   estimation engine looks up rate-card → priced Estimate
       │   template engine fills estimation-templates/*.xlsx
       ▼
7. "Generate deliverable" → for each chosen DeliverableType
       │   deliverable.section task → structured section bodies
       │   template engine fills deliverable-shells/<kind>-v1.docx/pptx/xlsx
       ▼
8. Review → Approve → Export DOCX (with embedded diagrams)
```

---

## Adding or changing KB content — the workflow

1. **Edit or add the JSON file** in `packages/knowledge-seed/<family>/`.
2. **Re-seed**: from the repo root, run `pnpm db:seed`. (This is a
   Turbo alias to `tsx prisma/seed.ts` inside `apps/web` — no flags,
   no migration needed, takes a few seconds.) The seed is idempotent
   on most tables — existing rows get upserted; new rows get
   inserted; rows that disappeared from JSON are left untouched (no
   destructive delete) unless you explicitly drop them via Prisma
   Studio / migration.

   **Prereqs:** Postgres must be running (`docker-compose up -d` if
   it isn't), and if you edited `schema.prisma` since the last
   codegen you also need `pnpm db:generate` first.

   **Quick sanity check** that the new artifact landed:

   ```bash
   docker exec ai-assisted-assessment-engine-postgres-1 \
     psql -U copilot -d assessment_copilot \
     -c "SELECT artifact_type, name, version FROM knowledge_artifacts WHERE artifact_type = 'FRAMEWORK';"
   ```
3. **Verify**: run an assessment end-to-end against the changed
   artifact, or check the relevant tab in the UI. There are smoke
   scripts under `scripts/smoke/` that exercise specific paths.
4. **PR the change**: KB content lives in git. A teammate reviewing
   the diff sees exactly what changed — that's the whole point of
   "JSON files, not admin CRUD".

**Things to know before editing:**

| Editing… | Affects existing assessments? | Notes |
|---|---|---|
| Framework rubric anchors | New analysis runs only; existing `DomainScore` rows keep their text until re-run | Open assessments aren't retroactively rescored. |
| Question template (`question-templates/*.json`) | New assessments only — existing assessments keep their seeded questions. | Add new domain → re-seed → only the new domain's questions land. |
| Risk pattern | New analysis runs only. | Catalog reload happens at every `analysis.synthesis` call. |
| Role catalog | New estimation runs only; existing `Estimate` rows keep their role mix. | Removing a role doesn't break old estimates, but new runs can't pick it. |

---

## Versioning

Files have a `version` integer or a `-v<N>` filename suffix. The
seed loader picks the file as-is — there's no "latest version
wins" logic. **To ship a new version**: keep the old file around for
historical reproducibility, drop the new file beside it, and update
the seed loader's pick if you want the new one to be default. In
practice the project's been monotone (v1 of everything) and bumps
have been "edit the file in place with care".

---

## Tips & gotchas

- **`activeDomains` is the load-bearing field** — it controls which
  question packs seed, which rubric anchors load, which risk
  patterns the AI prompt includes. Get this list right at assessment
  creation; changing it later only adds, never replaces.
- **Domain `key`s are snake_case** (`security_iam`,
  `business_context`). The UI translates them via
  `lib/domain-labels.ts` (`domainLabel()`) — snake_case never reaches
  the user.
- **Role names are spelled exactly** between role catalog and rate
  card. There's no fuzzy match. A trailing space or different
  capitalisation = no price lookup = blank price row.
- **`triggerConditions` on risk patterns is free-form text** that
  goes into the prompt. The AI uses it to judge fit — it's not a
  rules engine. Keep it human-readable.
- **`AssessmentMode`** (`EXISTING_SYSTEM` / `GREENFIELD` /
  `MODERNIZATION` / `AUDIT` / `PRE_IMPLEMENTATION`) is a separate
  axis from domain — frameworks declare `applicableTo.assessmentModes`.
  A greenfield framework wouldn't typically activate a
  "current-state architecture" domain.
- **Customer-uploadable templates can shadow workspace defaults**
  per `TemplateKind`. If a customer has uploaded and approved a
  custom assessment-report template, that one wins for assessments
  in their engagement. The workspace defaults remain the fallback.
- **Soft-failure on template fill** means a broken binding never
  blocks the parent run. Check the AuditLog for `*_FAILED` rows if a
  deliverable downloaded without an expected piece.

---

## Quick reference

| I want to… | Edit |
|---|---|
| Add a new assessment-domain question pack | `question-templates/<domain>.json`, plus add the domain to a framework's `domains[]` |
| Change how a domain is scored | The relevant `frameworks/*.json` → `domains[<key>].scoringCriteria` |
| Add a new canonical risk | Append to `risk-patterns/common-architecture-risks.json` (or split into a new file) |
| Add a new role | `role-catalog/standard-roles.json` (plus add a matching row in the rate card via `/admin/rate-cards`) |
| Change billing rates | `/admin/rate-cards` in the running app — *not* covered in this guide. |
| Edit the estimation workbook or a deliverable shell | See [`templates.md`](./templates.md) — those live in the `Template` table, not in `KnowledgeArtifact`. |
| Add a new framework (for a new assessment type) | `frameworks/<type>.json` + corresponding `AssessmentType` seed row |
