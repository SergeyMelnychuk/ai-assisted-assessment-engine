# Engagements Guide

This guide walks through engagements end-to-end: what they are, how
to create one, what you do inside one, how access works, and how to
wind one down. It's for **consultants and engagement managers** using
the app day-to-day. If you've never touched the tool before, read it
top to bottom; if you're already familiar, jump to the section you
need from the table of contents below.

- [What an engagement is](#what-an-engagement-is)
- [Creating an engagement](#creating-an-engagement)
- [The engagement workspace — tour of the tabs](#the-engagement-workspace--tour-of-the-tabs)
- [A typical engagement, start to finish](#a-typical-engagement-start-to-finish)
- [Members and access](#members-and-access)
- [Engagement status lifecycle](#engagement-status-lifecycle)
- [Archiving and deletion](#archiving-and-deletion)
- [What lives at the engagement level vs the assessment level](#what-lives-at-the-engagement-level-vs-the-assessment-level)
- [Tips and gotchas](#tips-and-gotchas)

---

## What an engagement is

An **engagement** is the top-level container for a piece of client
work — for example, *"Acme Cloud Modernization Assessment"* or
*"NorthStar Bank Architecture Audit"*. Everything you do in the tool
hangs off an engagement:

- One or more **assessments** (the actual units of work — an
  engagement can have several assessments of different types)
- Uploaded **documents** (RFPs, architecture briefs, meeting notes,
  past audits, anything the AI can analyse)
- Linked **source-code repositories** (GitHub / GitLab / Azure /
  Bitbucket via personal-access tokens stored in an encrypted vault)
- Customer-uploaded **templates** (Excel estimation workbooks, Word
  reports, PowerPoint decks) that override the workspace defaults
  for this engagement
- **Members** with role-based access
- An **audit log** of every meaningful action

You only have access to engagements you've been added to (admins can
see everything). Engagements are the unit of access control — once
you're a member, you can use every assessment, document, and finding
inside.

---

## Creating an engagement

From the **Engagements** page (the landing screen after login), click
**New engagement**. You fill three fields:

| Field | Required | Notes |
|---|---|---|
| **Engagement name** | Yes | The display title. Use a recognisable name your team will search for later — "Acme Cloud Modernization", not "Acme proj 3". |
| **Client** | Yes | The customer organisation. Useful for filtering when you work with several engagements for the same client. |
| **Industry** | No | A free-text tag (e.g. "Financial Services", "Healthcare"). Doesn't drive any automation today, but it's a useful label. |

When you click **Create**:

- The engagement is created with status **ACTIVE** — you can start
  work immediately. There's no "draft" step to publish out of.
- You're automatically added as the **OWNER**.
- You land on the engagement detail page.

That's it. There are no other required fields. You don't pick the
assessment type yet — assessments are created separately from the
**Setup** tab.

---

## The engagement workspace — tour of the tabs

The engagement detail page (`/engagements/<id>`) is a tabbed
workspace. Here's what each tab does:

### Setup
Where you **create assessments** for this engagement and fill in
project context. An engagement isn't useful until it has at least
one assessment. Setup is a two-phase wizard:

1. Pick an **assessment type** (e.g. *Existing System Review*,
   *Greenfield Discovery*, *Modernization Assessment*, *Audit*,
   *Pre-Implementation Review*). The type controls which framework,
   domains, and question packs get seeded.
2. Fill in **project context** — narrative fields the AI uses as
   first-class context (current pain points, business goals,
   constraints).

Multiple assessments per engagement is the normal pattern. For
example: one assessment for current-state architecture, a second for
the proposed greenfield target.

### Documents
Upload anything the AI should learn from: RFPs, slide decks, runbooks,
architecture briefs, BPMN diagrams, code archives. Each file goes
through ingestion (extraction → chunking → embedding) and shows its
status (`PENDING` → `PROCESSING` → `READY` / `FAILED`).

Supported formats include PDF, DOCX, PPTX, XLSX, Markdown, plain text,
and image-based diagrams (extracted via OCR / vision). Archives
(`.zip`, `.tar.gz`) fan out into child documents automatically with
safety gates for size, depth, and zip-slip.

You can tag each upload with a **domain** so its chunks land in the
right per-domain evidence bucket from day one (e.g. security docs
into `security_iam`, ops docs into `devops_cicd`).

### Evidence
The **Evidence Explorer** — search across every chunk extracted from
every document and repo in this engagement. Use it to:

- Type-ahead semantic + lexical search (the hybrid retrieval flag
  changes which ranker is used, but the UI is the same)
- Filter by domain and by source document
- Read a chunk in context with its ±2 neighbours (click any chunk
  preview to open the context window)
- **Re-tag** mis-classified chunks in bulk after ingestion if the
  auto-classifier or upload domain was wrong

This tab is *search only*; the document index lives on the Documents
tab.

### Questions
The per-assessment intake interview. Baseline questions are seeded
from the question-template knowledge base (see the
[Knowledge Base guide](./knowledge-base.md)) according to the
assessment's active domains. You answer in plain text or via
multiple-choice; the AI uses your answers as factual context during
synthesis.

Answering a question can trigger **AI-generated follow-ups**
(adaptive questions tailored to your previous answers). Follow-ups
land in the same list, tagged so you can tell which are AI vs.
baseline. The coverage strip shows what % of each domain you've
answered.

### Findings, Risks, Recommendations
These three tabs are the AI's **analysis output**, surfaced per
assessment. After you click **Run analysis** (usually from the
assessment page itself), the engine fans out per-domain:

- **Findings** — factual observations grounded in evidence and answers
- **Risks** — issues mapped against the risk-pattern catalog, with
  impact, likelihood, and mitigation
- **Recommendations** — proposed actions, prioritised

Each row links back to the **evidence trail** that produced it — the
exact chunks the AI cited, with click-through to the source document
or repo file (with line-level highlighting where available).

You need to pick an assessment first if the engagement has more than
one — these tabs are scoped per-assessment.

### Scoring
The **domain maturity scores** (1–5) the AI produced for the chosen
assessment, anchored to the rubric defined in the framework. Each
score shows the 1-line rationale + the rubric anchor for the chosen
level.

### Team & Estimate
Where the AI proposes a **team and effort estimate** for the
recommended path. It picks roles from the role catalog (see the
[Knowledge Base guide](./knowledge-base.md) §4), assigns seniorities
and hour counts, and prices the result against the active rate card.

Output is editable — you can adjust hours, swap seniorities, add or
remove roles. The estimate flows into the Estimate workbook on the
Templates tab.

### Deliverables
**Generate the final outputs** — the polished documents you hand to
the client. Available types depend on which templates exist; the
list usually includes:

- **Executive Summary** (PowerPoint)
- **Assessment Report** (Word)
- **Risk Register** (Excel)
- **Target-State Architecture** (PowerPoint)
- **Roadmap** (PowerPoint)
- **Team Proposal** (Word)
- **Estimate Summary** (Excel)
- **Assumptions & Gaps** (Word)
- **SOW Draft** (Word)
- **Greenfield Discovery** (Word — for greenfield assessments)

The deliverable engine fills the chosen template (a customer-uploaded
one if the engagement has an APPROVED override, otherwise the
workspace default) with the assessment's findings, risks, scoring,
and estimates. See the [Templates guide](./templates.md) for the
binding lifecycle.

### Templates
Upload **engagement-scoped templates** — customer-supplied Excel /
Word / PowerPoint files that override the workspace defaults for
this engagement only. The AI proposes a JSON binding mapping engine
outputs to cells/placeholders; a human approves; the binding kicks
in for any subsequent deliverable generation.

Lifecycle: **PROPOSED → APPROVED → DEPRECATED**. Multiple versions
of the same template kind can coexist; only the APPROVED ones are
candidates at fill time.

### Export
A lightweight export surface to pull findings / risks /
recommendations out as Excel or PDF without the full deliverable
generation flow. Useful for quick handoffs or ad-hoc reporting.

### Assessments
Direct deep-links into individual assessments — clicking an
assessment opens the assessment-level workspace, which has its own
finer-grained controls (workflow popup, repository links, agent runs,
review/approve flow).

---

## A typical engagement, start to finish

A normal flow looks roughly like this:

```
1. Create engagement                     ← Engagements list → New
2. Setup → create first assessment       ← pick type, fill context
3. Documents → upload everything         ← RFP, briefs, BPMN, code zips
   (Setup → link repos for source code)
4. Questions → answer baseline + follow-ups
5. (Optional) Evidence Explorer to spot-check that the AI has the
   right chunks indexed before you run analysis
6. Run analysis (from the assessment page)
       │  per-domain fan-out
       │  → Findings, Risks, Recommendations, Scoring populate
       ▼
7. Team & Estimate → review + adjust
8. Templates → upload customer-supplied shells (if any) and approve
9. Deliverables → generate the outputs
10. Review + Approve in the assessment view
11. Export DOCX / XLSX / PPTX → hand to client
12. Mark engagement COMPLETED → eventually ARCHIVED
```

Steps 3–5 are heavily parallelizable across team members — that's
what the role system is for (below).

---

## Members and access

Engagements are the unit of access control. You can only see and
work in engagements you're a member of. Members can have four roles:

| Role | What they can do |
|---|---|
| **OWNER** | Everything CONTRIBUTOR can do, plus: rename the engagement, change status (ACTIVE / COMPLETED / ARCHIVED), add/remove/reassign other members. |
| **CONTRIBUTOR** | Create assessments, upload documents, link repos, answer questions, run analysis, generate deliverables. The default working role. |
| **REVIEWER** | Read everything; comment / approve in review flows. Can't kick off new analysis or modify content. |
| **VIEWER** | Read-only — useful for stakeholders who want a window into progress without touching anything. |

There's also a platform-level **ADMIN** role (not engagement-scoped)
that bypasses membership entirely and can see / mutate any
engagement. Admins are the only ones who can delete an engagement
(see below).

**Adding a member.** From the engagement detail page, open the
members section, search by name or email, pick a role, and add them.
The user must already exist as a platform user — the search lists
people you're allowed to add.

**Changing a role or removing someone.** From the same members
section. Removing yourself as OWNER is blocked if you're the last
OWNER on the engagement (someone else has to take over first).

Every membership change is audit-logged.

---

## Engagement status lifecycle

Status is a flat enum: **ACTIVE → COMPLETED → ARCHIVED** (with
**DRAFT** reserved but unused — new engagements skip it and start at
ACTIVE).

- **ACTIVE** — Default. Work is happening; everything is editable
  according to your role.
- **COMPLETED** — Work is done; the engagement is read-mostly.
  Members can still open it but the expectation is that no further
  analysis or deliverable generation will happen.
- **ARCHIVED** — Hidden from the default engagements list. Use the
  "Show archived" toggle on the list page to see them. Required
  state before an admin can delete the engagement.

Transitions are made by OWNERs (or admins) via the status dropdown
on the engagement header. There are no preconditions enforced —
you can move between any two states. Each transition writes an
audit-log row capturing the prior and new status.

---

## Archiving and deletion

**Archiving** is reversible. Set status to ARCHIVED to hide an
engagement from your default view; flip it back to ACTIVE or
COMPLETED later if needed. Archived engagements still hold all their
data — assessments, documents, evidence, repos, templates.

**Deletion** is irreversible and **admin-only**. The Delete button
only appears for admins, and only when the engagement is in
**ARCHIVED** status. Two-click confirm.

When an engagement is deleted:

1. The system collects every MinIO storage key the engagement owns
   (uploaded documents, diagram images, template files, populated
   deliverable fills) *before* the database delete.
2. Postgres cascades take out the engagement and every dependent
   row across 22+ child tables — assessments, questions, evidence,
   findings, risks, deliverables, agent runs, audit log, templates,
   the lot.
3. After the DB commits, the system best-effort-sweeps the MinIO
   blobs. Sweep failures are logged but never roll back the DB
   delete — the row counts in the audit log show what was actually
   removed.

So the safe sequence is: COMPLETED → ARCHIVED → (later) admin
deletes. If you delete an engagement by mistake, **the data is
gone** — there's no soft-delete or undo. Archive first; delete only
when you're sure.

---

## What lives at the engagement level vs the assessment level

A common source of confusion. The engagement is the **container**,
not the unit of analysis. The unit of analysis is the
**assessment**.

```
Engagement
  ├─ Members, status, audit log
  ├─ Documents (shared across all assessments)
  ├─ Templates (engagement-scoped overrides)
  ├─ Repository links
  └─ Assessment A (e.g. EXISTING_SYSTEM)
      ├─ activeDomains, framework, mode
      ├─ Questions + Answers
      ├─ Findings, Risks, Recommendations
      ├─ DomainScores
      ├─ Team proposals, Estimates
      ├─ Deliverables (filled outputs)
      └─ Agent runs, review state
  └─ Assessment B (e.g. MODERNIZATION)
      ├─ … its own copies of all of the above
```

What this means in practice:

- **Documents are shared.** Upload an RFP once; every assessment in
  the engagement can use it. The evidence retriever respects the
  assessment's `activeDomains`, so a security-only assessment won't
  pull random ops chunks.
- **Findings / risks / scores are not shared.** Each assessment runs
  its own analysis and owns its own outputs. Engagement-level tabs
  like Findings / Risks / Recommendations make you pick an
  assessment first.
- **Templates are engagement-scoped.** A customer-uploaded
  Word/Excel/PowerPoint override stays inside this engagement and
  doesn't leak to others.
- **Repos are typically linked per-assessment**, but the encrypted
  PAT credential is stored at engagement scope (one credential vault
  per engagement, used by every repo link inside).

---

## Tips and gotchas

- **Pick a meaningful engagement name.** It shows up in the list,
  in audit logs, in deliverable metadata, and in every PR/code-review
  hand-off. "Acme Cloud Modernization 2026 Q2" is much easier to
  find later than "Acme assess".
- **Tag documents with a domain at upload time.** It's the cheapest
  way to keep the evidence buckets clean. If you skip it, chunks
  land in the catch-all `ingested` bucket and the per-domain filter
  in Evidence Explorer won't surface them under the right tab.
- **One engagement, many assessments.** It's normal — current-state
  audit + greenfield discovery + modernization roadmap can all live
  in the same engagement and share the same uploaded evidence base.
- **Mark engagements COMPLETED when work ends.** Don't leave dozens
  of ACTIVE engagements hanging around — it makes the dashboard
  noisy and obscures which work is actually live.
- **Archive before you delete, never the reverse.** Deletion is
  irreversible and only admins can do it. The two-click confirm is
  there for a reason.
- **The audit log captures everything.** Status changes, member
  changes, document uploads, analysis runs, deliverable generations,
  AI calls (with token + cost), template approvals. If you ever
  need to reconstruct "who did what when", it's all there.
- **Members ≠ assignees.** Adding someone as a CONTRIBUTOR gives
  them access; it doesn't assign them specific questions or tasks.
  Per-question / per-assessment ownership is not modelled today.
