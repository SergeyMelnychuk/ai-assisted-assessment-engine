# ADR-0010: Repository ingest — GitHub tarball API over `git clone`

- **Status:** Accepted
- **Date:** 2026-04-18
- **Deciders:** Serhii Melnychuk (project lead), Claude agents during Phase 3 build
- **Related:** ADR-0008 (archive safety gates), ADR-0009 (PAT credentials),
  `docs/design/phase-3-roadmap.md` §Week 6

## Context

Week 6's `ingest-repository` worker has to get the code of a linked
GitHub repo onto the MinIO bucket so the Week 5 `ingest-archive`
pipeline can fan it out into per-file Documents + Evidence rows. The
transport choice shapes the worker image, the failure modes, the
re-sync model, and the set of credentials we have to handle.

Two viable approaches:

- **`git clone` + server-side diff.** The worker runs `git` against
  the remote, clones (shallow or full), walks the working tree, and
  on re-sync uses `git fetch` + `git diff --name-only <lastSha>..HEAD`
  to ingest only changed files.
- **Tarball HTTP API.** GitHub exposes
  `GET /repos/{owner}/{repo}/tarball/{ref}` — one HTTP call returns
  the repo as a gzip'd tarball up to 100 MB. No `git` binary required.

The question isn't "which is better forever" — it's "which ships the
MVP the fastest while keeping the upgrade path open."

## Decision

Use the **GitHub tarball API** for MVP. The worker makes one HTTP
call, streams the response straight into MinIO under
`repo-archives/{linkId}/{sha}.tar.gz`, then enqueues an
`ingest-archive` job that runs the Week 5 pipeline we already
shipped — safety gates, `.gitignore` + blacklist filter, per-file
`ingest-document` fan-out.

Concrete shape:

- [`apps/web/src/server/services/repo/github-provider.ts`](../../../apps/web/src/server/services/repo/github-provider.ts)
  implements `RepoProvider.fetchTarball(link)` against
  `https://api.github.com/repos/{owner}/{repo}/tarball/{ref}` with
  `Authorization: Bearer <decrypted PAT>`.
- Streams chunks from the HTTP response into MinIO — the worker
  never holds the whole tarball in memory. Safety gate:
  `REPO_TARBALL_MAX_BYTES` (default 100 MB, env-configurable) cuts
  the stream if GitHub's advertised `Content-Length` exceeds it.
- Records the remote SHA from the `X-GitHub-Repository-Commit-SHA`
  header (falls back to `ETag` parsing when absent) and writes it to
  `RepositoryLink.lastSha`. Re-sync = "call the same endpoint again,
  get a fresh SHA, if it matches skip the whole pipeline."
- Classifier coverage:
  [`error-classifier.ts`](../../../apps/web/src/server/services/ai/error-classifier.ts)
  adds `REPO_AUTH_FAILED` (401), `REPO_NOT_FOUND` (404),
  `REPO_RATE_LIMITED` (403 + `x-ratelimit-remaining: 0`), and
  `REPO_TARBALL_TOO_LARGE`. One-shot `Retry-After` honour on 429 — no
  retry loops (consistent with ADR-0001's no-automatic-retry stance).

## Alternatives considered

- **`git clone` in the worker.** Rejected because it requires a `git`
  binary in the worker image (extra layer, extra CVE surface), an
  ssh-agent or `credential.helper` setup to feed the PAT (ergonomic
  cost and one more leak site), and a local clone on the worker's
  filesystem (quota management, cleanup on OOM kill). For MVP we'd
  build all that plumbing without exercising its one real advantage —
  incremental fetch — because Week 6 doesn't do incremental fetch
  anyway. Written into the follow-ups: revisit if per-file diffing
  becomes a roadmap priority.
- **Isomorphic `isomorphic-git` (pure-JS git in the worker).**
  Rejected because it needs a writable working tree on the worker
  disk (same quota problem), its HTTPS transport is thin, and it's
  nontrivial to use against GitHub's smart-HTTPS endpoint with a PAT
  at the byte level. More complexity for the same end-state as the
  tarball API.
- **Per-file GitHub contents API** (`GET /repos/.../contents/{path}`).
  Rejected on rate-limit math alone — a 500-file repo is 500 API
  calls, each blob capped at 1 MB, each decoded separately. Archive
  is one call. The contents API is still useful for targeted re-sync
  of a single file if that becomes a feature.
- **GitHub-hosted LFS objects.** Not handled in MVP — the tarball API
  returns LFS pointer files, not the resolved blobs. Acceptable for
  the code-assessment use case (we don't model large binary payloads
  as evidence); called out in follow-ups if a customer hits it.

## Consequences

- **Positive.** Worker image stays minimal — Node, Prisma, the
  archive pipeline, that's it. No `git`, no ssh keys, no
  `.gitconfig` to manage.
- **Positive.** One HTTP call = one failure mode to classify. No
  "what happens if fetch succeeds but diff crashes" shape to reason
  about. The existing `ingest-archive` job handles everything after
  the tarball lands.
- **Positive.** PAT handling is narrower — the token is read once per
  sync, passed in an `Authorization` header, never touches disk. The
  ssh-agent failure mode doesn't exist.
- **Positive.** Audit trail naturally captures `lastSha`, so a review
  a week later can show "these findings came from commit `abc123`".
- **Negative.** No incremental fetch. Every re-sync pulls the full
  tarball and re-ingests files whose `content_sha` hasn't changed.
  The Week 3 `content_sha` column saves us on the embedding side —
  re-embed only on hash mismatch — but we still move the bytes. On a
  100 MB repo with a 10-line change this is objectively wasteful. We
  accept it for MVP; a follow-up pulls diffs via `GET /repos/.../compare`
  once a customer has enough engagement volume to feel the cost.
- **Negative.** The tarball API has a hard 100 MB limit on GitHub's
  side. Large monorepos will fail with `REPO_TARBALL_TOO_LARGE`;
  we surface this as a classified error with a "split the repo" next
  step. Customers with larger repos are on the GitHub App + `git clone`
  migration path.
- **Negative.** No sparse-checkout. If the consultant links a
  monorepo but only cares about `packages/web/`, the worker ingests
  the whole archive and relies on the `.gitignore` / blacklist filter
  to prune it. Storage pressure is O(source size) even when semantic
  interest is O(one subfolder). Mitigated today by the size + ignore
  limits; properly solved post-roadmap.
- **Neutral.** Re-sync UX shape: the consultant clicks "Re-sync now",
  we fetch the full tarball, compare SHA — if same, no-op; if
  different, run the full pipeline. No partial-state "some files
  stale" surface.

## Follow-ups

- [ ] Post-roadmap — `git clone` transport behind the `RepoProvider`
      interface for customers who need to bypass the 100 MB limit.
      Tracked against the GitHub App migration (ADR-0009).
- [ ] Post-roadmap — diff-based re-sync using
      `GET /repos/.../compare/{lastSha}...HEAD` to skip unchanged
      files instead of re-streaming.
- [ ] Post-roadmap — LFS resolution for repos that use Git LFS.
- [ ] Post-roadmap — sparse-ingest configuration on `RepositoryLink`
      (a path prefix) for monorepo customers.

## References

- `apps/web/src/server/services/repo/github-provider.ts`
- `apps/web/src/server/workers/ingest-repository.ts`
- `apps/web/src/server/services/ai/error-classifier.ts` — REPO_* matchers
- [`docs/architecture/diagrams/repo-link-flow.mmd`](../diagrams/repo-link-flow.mmd)
- GitHub REST — `GET /repos/{owner}/{repo}/tarball/{ref}` —
  https://docs.github.com/en/rest/repos/contents#download-a-repository-archive-tar
- ADR-0009 — PAT-per-engagement credentials (the auth side of this ADR)
- ADR-0008 — archive safety gates (the downstream pipeline this feeds)
