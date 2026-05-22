# ADR-0008: Archive safety gates

- **Status:** Accepted
- **Date:** 2026-04-19
- **Deciders:** Phase 3 Week 5 implementer
- **Related:** `docs/design/phase-3-roadmap.md` §Week 5,
  `docs/architecture/README.md` §5 (background job pipeline),
  `apps/web/src/server/workers/ingest-archive.ts`,
  `apps/web/src/server/services/ai/error-classifier.ts`.

## Context

Week 5 introduces archive upload: a consultant can drop a `project.zip`
and the ingest pipeline fans out one child Document + `ingest-document`
job per file inside. The archive-extract step is the first place in the
system where an adversarial or malformed input can cause unbounded
resource consumption:

- **Zip bombs.** A 10 KB zip can decompress to gigabytes. Without a
  cap, the worker would OOM or fill MinIO before anyone noticed.
- **Path traversal / zip-slip.** An archive entry named
  `../../etc/passwd` or an absolute path `/tmp/exfil` can write
  outside the intended namespace. Symlinks in tar archives are the
  classic escape hatch for the same attack.
- **Resource-exhaustion via entry count.** A million zero-byte entries
  still burn a Prisma `create` per row, still enqueues a million
  BullMQ jobs, still indexes a million rows.
- **Depth bombs.** Deeply nested trees (`a/b/c/d/.../200-levels`) blow
  up our listing UI and MinIO key length.

The project has no tenant isolation at the storage layer today —
every engagement shares a bucket — so a single bad upload blast-
radiuses across tenants. We want a *refuse-to-process* default, not a
best-effort defence. The consultant UX also needs a clear, classified
error so "why didn't my archive import?" has a diagnosable answer in
the audit log.

## Decision

Enforce fixed per-archive safety limits at the stream-extract layer,
emit classified errors on violation, and halt the extract loop at the
first hard failure. Limits are env-overridable for ops flexibility but
ship with defaults tuned for real-world repo zips rather than
pathological inputs:

| Gate | Default | Env variable | Rationale |
|---|---|---|---|
| Max uncompressed bytes | 500 MB | `ARCHIVE_MAX_UNCOMPRESSED_BYTES` | Covers the biggest monorepos we've seen without letting a zip bomb ruin a cluster. |
| Max entry count | 10 000 | `ARCHIVE_MAX_ENTRIES` | A fully-loaded `node_modules` is already bigger, which is why we ignore it by default. |
| Max path depth | 20 | `ARCHIVE_MAX_DEPTH` | Double the deepest real path we've observed (10-level Java packages). |
| Symlinks | Rejected | — | Zip-slip / tar-escape defence. Not overridable by env — this is a security floor. |
| Absolute paths | Rejected | — | Same threat class as symlinks. |
| `..` traversal segments | Rejected | — | Same threat class. |

Additionally we ship a **default ignore list** applied before the
gates are measured: `node_modules`, `.git`, `dist`, `build`, `target`,
`.next`, `__pycache__`, `*.lock`, `*.min.js`, `*.pyc`, `.DS_Store`,
`.env`, and the named lockfiles (`yarn.lock`, `pnpm-lock.yaml`,
`Cargo.lock`, `Gemfile.lock`, `poetry.lock`, `go.sum`). Users can layer
a `.copilotignore` at archive root for project-specific additions.

Every gate trip emits an `ArchiveSafetyError` whose message is tagged
with a machine-readable prefix (`ARCHIVE_ENTRY_LIMIT:`,
`ARCHIVE_SIZE_LIMIT:`, `ARCHIVE_DEPTH_LIMIT:`, `ARCHIVE_SYMLINK:`,
`ARCHIVE_MALFORMED:`). The classifier at
`services/ai/error-classifier.ts` routes these to dedicated
`ErrorCategory` values so the UI `FailureBanner` renders actionable
copy ("split the archive", "flatten deepest directories", etc.) rather
than the raw stack trace. The audit-log row carries the offending
`entryPath` for diagnosability.

## Alternatives considered

- **Soft limits with warnings.** Extract everything, then flag
  oversize archives after the fact. Rejected: by that point we've
  already eaten the cost. A 100 GB decompression doesn't become safe
  just because we flag it afterwards.
- **Post-hoc scanning via a sandboxed service.** Hand the archive to a
  per-tenant container and let it decompress in isolation. Rejected
  for MVP: an order of magnitude more infra (cgroups, seccomp, quota
  management) for a threat we can close with a streaming cap.
- **Accept symlinks but resolve relative to archive root.** Technically
  safer than `--dereference`, but still a footgun — one misclassified
  symlink and we silently write outside the archive namespace.
  Refusing is unambiguous.
- **Per-tenant limits instead of global.** Would let generous tenants
  raise their own ceiling. Rejected until we have real tenant
  isolation (post-Phase 3); for now the global ceiling is a hard
  ceiling regardless of who's uploading.
- **Buffer the whole archive then validate.** Simpler code, but
  defeats the streaming constraint from the roadmap and makes the size
  gate useless (we've already allocated the memory).

## Consequences

**Positive.**

- Archives from a 50-repo engagement (typically < 100 MB uncompressed
  after ignoring `node_modules`) sail through untouched.
- Zip bombs, path-traversal, and depth bombs fail fast with a
  consultant-friendly error message instead of OOMing the worker.
- Ops can tune the three size-ish knobs via env without a code change.
  The security-floor gates (symlink, absolute, traversal) stay
  unreachable by config to prevent accidental footgun disable.

**Negative.**

- Legitimately-large archives (a 2 GB data dump) are refused and must
  be split. Acceptable cost for the defence.
- Entries already fanned-out before the violating entry still get
  ingested. The extract loop can't cleanly unwind children that have
  already hit Prisma and BullMQ. We live with partial state and rely
  on the parent's `ingestStatus=FAILED` to signal "don't trust this
  archive" — children show up as orphans in the audit log, which is
  searchable.
- No support for encrypted archives. We treat "can't read the central
  directory" as `ARCHIVE_MALFORMED` without distinguishing "corrupt"
  from "encrypted". Realistic to revisit only once a user asks.

**Neutral.**

- The ignore list is a shared pattern — same file names are
  off-limits in Week 6 repo-linking too. Keeping it in the archive
  worker for now; promote to a shared module if repo-linking diverges.

## Follow-ups

- [ ] UI: add per-gate copy to the `FailureBanner` templates so
      `ARCHIVE_DEPTH_LIMIT` renders with the exact depth cap, not the
      generic category text.
- [ ] Telemetry: counter for each gate-trip category so we can see
      which limit is being hit most often and tune defaults.
- [ ] Consider a "dry-run" mode for the UI — pre-flight the archive,
      list what *would* be ingested, and only enqueue after user
      confirmation. Deferred until the single-flight flow is proven.

## References

- `docs/design/phase-3-roadmap.md` §Week 5
- `docs/architecture/README.md` §5 (background job pipeline)
- Zip-slip reference: https://snyk.io/research/zip-slip-vulnerability
- yauzl readme (zip stream library we use):
  https://github.com/thejoshwolfe/yauzl
- tar-stream readme: https://github.com/mafintosh/tar-stream
