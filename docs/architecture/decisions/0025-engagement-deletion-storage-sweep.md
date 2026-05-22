# ADR-0025: Engagement deletion — DB cascade plus best-effort storage sweep

- **Status:** Accepted
- **Date:** 2026-05-10
- **Deciders:** Engineering
- **Related:**
  [ADR-0008](./0008-archive-safety-gates.md) (the other path that
  writes Documents under an engagement),
  [ADR-0018](./0018-template-binding.md) (uploads `Template`
  objects under the engagement),
  [ADR-0020](./0020-soft-failure-best-effort-work.md) (the
  failure shape this delete uses for the storage sweep).

## Context

Engagements accumulate a large surface area of dependent data:

- `EngagementMember`, `Assessment`, `Template`, `AgentRun`,
  `AgentCredential` as direct children.
- Through `Assessment`: `Document`, `Diagram`, `Evidence`,
  `Finding`, `Risk`, `Recommendation`, `Question`, `Answer`,
  `DomainScore`, `RoleProposal`, `Estimate`, `Deliverable`,
  `DeliverableSection`, `Review`, `RepositoryLink`, `TemplateFill`,
  `ProjectContext`, plus the embedding rows on `Evidence`.
- MinIO objects backing every `Document.storagePath`,
  `Diagram.imageStoragePath`, `Template.storagePath`, and
  `TemplateFill.outputDocument.storagePath`.

Until now there was no way to delete an engagement at all — the
schema cascaded the FKs but the tRPC route didn't exist. Demo and
test engagements piled up, and once a customer starts a real
engagement we need a way to fully reclaim its data on request
(both for housekeeping and for GDPR-style "right to erasure").

We need a delete that:

- Reclaims **every** row Postgres cascades, plus **every** MinIO
  object the engagement owns.
- Doesn't leave the DB and storage in disagreement (an orphan blob
  is annoying but tolerable; a referenced blob that's gone is
  worse than not deleting).
- Is gated tightly enough that nobody deletes by accident.

## Decision

A single ADMIN-only tRPC mutation, `engagement.delete`.

**Authz.** ADMIN-only — the procedure throws `NOT_FOUND` for non-
admins (not `FORBIDDEN`) so probing the router for admin endpoints
doesn't leak their existence. Same pattern as `assertAdmin` in
`admin-settings.ts`.

**Precondition.** Refuses unless `engagement.status === "ARCHIVED"`.
Archive is the user's deliberate commitment to losing the data; we
keep the affordance the same shape as the assessment-delete path
(archive-required, two-click confirm in the UI).

**Two-phase cleanup.**

1. **Collect storage keys before the DB delete.** Four queries against
   `Document`, `Diagram`, `Template`, and `TemplateFill.outputDocument`,
   joined to the engagement via its assessments. Keys land in a `Set`
   so duplicates don't double-delete. Sentinel `"pending"` keys (rows
   whose ingest didn't finish) are excluded.

2. **Cascade-delete in Postgres.** `db.engagement.delete()` triggers
   the FK cascade; everything below comes out in a single transaction.
   The schema's `onDelete: Cascade` annotations cover all 5 direct
   children + 22 indirect children via `Assessment`.

3. **Sweep MinIO after the DB commits.**
   `Promise.allSettled(deleteObject(key))` over the collected keys.
   Failures are logged in the audit row but never roll back the DB
   delete (ADR-0020 soft-failure): the database is the source of
   truth, and an orphan blob is recoverable later, while a DB row
   that points at a missing blob is worse than the inverse.

**Audit row.** Single `DELETE` row on `Engagement` with details:

```jsonc
{
  "id": "...",
  "name": "...",
  "clientName": "...",
  "priorStatus": "ARCHIVED",
  "counts": {
    "documents": 42,
    "diagrams": 5,
    "templates": 3,
    "templateFills": 8,
    "storageBlobsAttempted": 50,
    "storageBlobsDeleted": 50,
    "storageBlobsFailed": 0
  },
  "blobFailures": []
}
```

The first 5 failure messages (if any) are captured so operators have
a thread to pull when reconciling MinIO state.

**UI surface.** `DeleteEngagementControl` on the engagement detail
header. Renders only when `session.user.role === "ADMIN"` AND
`status === "ARCHIVED"`. Two-click confirm (Delete → Really delete? +
Cancel) mirrors the existing assessment delete pattern. On success
the cache is invalidated and the page routes to `/engagements`.

## Alternatives considered

- **Sweep MinIO inside the DB transaction.** Rejected — MinIO
  calls are network I/O, slow, and can fail. Holding the DB
  transaction open would lock the engagement row for seconds and
  invite contention; rolling back the DB cascade because a blob
  failed to delete is worse than leaving an orphan.
- **Queue the delete as a background job.** Rejected — the user
  expects "Really delete?" to mean *delete now*, and the cascade
  is well-bounded enough to fit in a tRPC mutation. A background
  path would also force a "deleting…" intermediate state on the
  detail page.
- **Soft-delete the engagement instead of hard-deleting.**
  Rejected — the existing archive state IS the soft-delete. Hard
  delete is the explicit "reclaim everything" affordance; adding a
  fourth state would dilute the lifecycle without freeing storage.
- **OWNER instead of ADMIN gate.** Rejected — engagement OWNER can
  already archive but shouldn't be able to nuke shared data on a
  whim. Deletion is operations-team territory.

## Consequences

**Positive**

- One-click reclamation that takes out both DB rows and storage.
- Audit row records the full scope of what was reclaimed, so
  operators can reconcile MinIO usage after the fact.
- Pattern is reusable — the same "collect keys → cascade →
  best-effort sweep" shape applies to assessment-delete (which
  currently only drops the DB rows; storage orphan reclamation
  there is a follow-up).
- Failure mode is bounded: DB-and-storage agree, or DB is
  authoritative and storage has known orphans listed in the audit
  row.

**Negative**

- MinIO orphans can still appear when an object delete fails. The
  audit row captures the failed keys, but a janitor job that
  replays them periodically is a follow-up.
- ADMIN-only means a delete request bottlenecks on the operations
  team. Acceptable trade — the alternative (every OWNER can delete)
  is worse.

**Neutral**

- AuditLog rows for the deleted engagement's entities stay
  retained — this is by design (business-event ledger is
  long-lived, separate from operational state).

## Follow-ups

- Janitor job that replays the `blobFailures` list from the audit
  row.
- Same storage-sweep pattern on `assessment.delete` — currently
  orphans the assessment's Documents and Template fills in MinIO.
- Periodic reconciliation: list all keys under `assessments/` and
  `templates/`, cross-check against `Document.storagePath` /
  `Template.storagePath`, delete anything dangling. Runs as a
  repeatable BullMQ job once we have the data to estimate its
  cost.
