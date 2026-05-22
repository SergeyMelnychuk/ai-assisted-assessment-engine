"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { trpc } from "@/lib/trpc";
import { Button, buttonVariants } from "@/components/ui/button";

/**
 * Tri-state archive filter. Default is "active" so the dashboard stays
 * focused on work in progress; "archived" surfaces only the archived
 * rows (the operator's audit / cleanup view); "all" mixes both.
 *
 * The server query is told to include archived rows for either
 * "archived" or "all" — the final shape is then narrowed client-side
 * so a single fetch covers all three states.
 */
type ArchiveFilter = "active" | "archived" | "all";

const ARCHIVE_FILTER_OPTIONS: readonly {
  value: ArchiveFilter;
  label: string;
}[] = [
  { value: "active", label: "Active only" },
  { value: "archived", label: "Archived only" },
  { value: "all", label: "Include archived" },
];

/**
 * Mirrors the `AssessmentStage` enum from Prisma. Hardcoded here (vs.
 * imported) to avoid pulling Prisma types into the client bundle —
 * the values are stable and any drift will surface as a tRPC type
 * mismatch the moment one is added.
 */
const STATUS_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "ALL", label: "Any status" },
  { value: "SETUP", label: "Setup" },
  { value: "INTAKE", label: "Intake" },
  { value: "QUESTIONING", label: "Questioning" },
  { value: "ANALYSIS", label: "Analysis" },
  { value: "DRAFTING", label: "Drafting" },
  { value: "REVIEW", label: "Review" },
  { value: "COMPLETED", label: "Completed" },
];
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";

const STATUS_VALUES = ["DRAFT", "ACTIVE", "COMPLETED", "ARCHIVED"] as const;
type EngagementStatus = (typeof STATUS_VALUES)[number];

function statusToneClass(status: string): string {
  // `text-foreground` on tinted backgrounds for max contrast — see the
  // matching treatment in `components/analysis/review-badges.tsx` and
  // `components/common/failure-banner.tsx`. Category hue stays on
  // border + background only.
  switch (status) {
    case "ACTIVE":
      return "border-green-500/40 bg-green-500/10 text-foreground";
    case "COMPLETED":
      return "border-blue-500/40 bg-blue-500/10 text-foreground";
    case "ARCHIVED":
      return "border-muted-foreground/30 bg-muted text-muted-foreground";
    case "DRAFT":
    default:
      return "border-border bg-muted text-foreground";
  }
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusToneClass(status)}`}
      aria-label={`Status: ${status}`}
    >
      {status}
    </span>
  );
}

/**
 * Editable status control. Renders a native `<select>` styled like the
 * badge so the control reads as a pill; falls back to the read-only
 * badge when the caller lacks OWNER/ADMIN. Optimistic updates are
 * deliberately avoided here — status transitions are rare and an
 * audit log entry is written server-side, so we'd rather display the
 * confirmed value than race the mutation.
 */
function StatusSelect({
  engagementId,
  status,
}: {
  engagementId: string;
  status: string;
}) {
  const utils = trpc.useUtils();
  const mutation = trpc.engagement.update.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.engagement.getById.invalidate({ id: engagementId }),
        utils.engagement.list.invalidate(),
      ]);
    },
  });
  const pending = mutation.isPending;
  return (
    <div className="flex items-center gap-2">
      <label className="sr-only" htmlFor={`engagement-status-${engagementId}`}>
        Engagement status
      </label>
      <select
        id={`engagement-status-${engagementId}`}
        value={status}
        disabled={pending}
        onChange={(e) =>
          mutation.mutate({
            id: engagementId,
            status: e.target.value as EngagementStatus,
          })
        }
        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 ${statusToneClass(status)}`}
      >
        {STATUS_VALUES.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
      {mutation.error ? (
        <span className="text-xs text-destructive" role="alert">
          {mutation.error.message}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Per-row archive / restore / delete controls for an assessment.
 *
 * Delete is gated on an already-archived row AND a two-click confirm —
 * the first click on "Delete" swaps in a "Really delete?" button that
 * has to be clicked again within a couple of seconds (state-driven, not
 * a timer). That beats `window.confirm()` for visual consistency and
 * keeps the destructive path behind a deliberate second action.
 */
function AssessmentRowActions({
  engagementId,
  assessmentId,
  archivedAt,
}: {
  engagementId: string;
  assessmentId: string;
  archivedAt: Date | string | null;
}) {
  const utils = trpc.useUtils();
  const invalidate = () =>
    Promise.all([
      utils.engagement.getById.invalidate({ id: engagementId }),
      utils.engagement.getById.invalidate({
        id: engagementId,
        includeArchived: true,
      }),
      utils.engagement.list.invalidate(),
    ]);
  const archive = trpc.assessment.archive.useMutation({ onSuccess: invalidate });
  const restore = trpc.assessment.restore.useMutation({ onSuccess: invalidate });
  const del = trpc.assessment.delete.useMutation({ onSuccess: invalidate });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const isArchived = archivedAt !== null;
  const busy = archive.isPending || restore.isPending || del.isPending;
  const error = archive.error ?? restore.error ?? del.error;

  return (
    <div
      className="flex shrink-0 items-center gap-1"
      // Swallow click so the wrapping <Link> doesn't navigate when the
      // user hits an action button.
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {error ? (
        <span className="mr-1 text-xs text-destructive" role="alert">
          {error.message}
        </span>
      ) : null}
      {isArchived ? (
        <>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => restore.mutate({ id: assessmentId })}
          >
            Restore
          </Button>
          {confirmDelete ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => del.mutate({ id: assessmentId })}
              >
                Really delete?
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          )}
        </>
      ) : confirmArchive ? (
        <>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              archive.mutate(
                { id: assessmentId },
                { onSuccess: () => setConfirmArchive(false) },
              );
            }}
          >
            Confirm archive
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setConfirmArchive(false)}
          >
            Cancel
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => setConfirmArchive(true)}
        >
          Archive
        </Button>
      )}
    </div>
  );
}

export function EngagementDetail({ id }: { id: string }) {
  const [archiveFilter, setArchiveFilter] = useState<ArchiveFilter>("active");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  // Server-side gate: ask for archived rows whenever the user wants
  // to see them. Final visibility (active-only vs archived-only vs
  // both) is narrowed below client-side.
  const includeArchived = archiveFilter !== "active";
  const { data, isLoading, error } = trpc.engagement.getById.useQuery(
    { id, includeArchived },
    {
      // Don't retry 404s — that's the authorization-deny signal.
      retry: (failureCount, err) =>
        err.data?.code !== "NOT_FOUND" && failureCount < 1,
    },
  );

  // Apply the client-side filters (search, archive narrowing, status)
  // to the fetched assessments. We tolerate `data` being undefined so
  // the hook order stays stable across the loading / error early
  // returns below.
  const filteredAssessments = useMemo(() => {
    if (!data) return [];
    const needle = searchQuery.trim().toLowerCase();
    return data.assessments.filter((a) => {
      if (archiveFilter === "active" && a.archivedAt !== null) return false;
      if (archiveFilter === "archived" && a.archivedAt === null) return false;
      if (statusFilter !== "ALL" && a.status !== statusFilter) return false;
      if (needle) {
        const haystack = [
          a.assessmentType.name,
          a.projectContext?.projectName ?? "",
          a.mode,
          a.status,
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [data, archiveFilter, statusFilter, searchQuery]);
  const hasActiveFilter =
    archiveFilter !== "active" ||
    statusFilter !== "ALL" ||
    searchQuery.trim() !== "";
  // `canMutate` gates the status dropdown + per-row archive/delete
  // actions; don't block rendering on it — the read-only badge is a
  // fine fallback while this resolves.
  const canMutateQuery = trpc.engagement.canMutate.useQuery(
    { id },
    { staleTime: 60_000 },
  );
  const canMutate = canMutateQuery.data ?? false;

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="mt-6 h-32 w-full" />
      </div>
    );
  }

  if (error) {
    const isNotFound = error.data?.code === "NOT_FOUND";
    return (
      <Card className="border-destructive/40 bg-destructive/5">
        <CardHeader>
          <CardTitle className="text-destructive">
            {isNotFound ? "Engagement not found" : "Couldn't load engagement"}
          </CardTitle>
          <CardDescription className="text-destructive/80">
            {isNotFound
              ? "It may have been deleted, or you don't have access."
              : error.message}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link
            href="/engagements"
            className="text-sm font-medium underline underline-offset-4"
          >
            Back to engagements
          </Link>
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">
              {data.name}
            </h1>
            {canMutateQuery.data ? (
              <StatusSelect engagementId={data.id} status={data.status} />
            ) : (
              <StatusBadge status={data.status} />
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {data.clientName}
            {data.industry ? ` · ${data.industry}` : ""} ·{" "}
            <span>
              Created{" "}
              {new Date(data.createdAt).toLocaleDateString(undefined, {
                dateStyle: "medium",
              })}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Per-assessment tabs moved to the selected-assessment row
              below — a tab at this level had no well-defined subject
              when multiple assessments lived on the engagement, and
              was outright broken when only archived assessments were
              visible (every link 404'd on the read-locked row). */}
          <Link
            href={`/engagements/${data.id}/setup`}
            className={buttonVariants()}
          >
            Start assessment
          </Link>
          <DeleteEngagementControl
            engagementId={data.id}
            status={data.status}
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="space-y-3">
              <div>
                <CardTitle className="text-base">Assessments</CardTitle>
                <CardDescription>
                  {data.assessments.length === 0
                    ? archiveFilter === "active"
                      ? "No assessments yet. Start one to configure scope and project context."
                      : "No assessments (including archived)."
                    : `${filteredAssessments.length} of ${data.assessments.length} assessment${
                        data.assessments.length === 1 ? "" : "s"
                      }${
                        hasActiveFilter ? " match the current filters" : ""
                      }`}
                </CardDescription>
              </div>
              {/* Filter toolbar. Search runs across the assessment type
                  name, project name, mode and status — broad enough that
                  the user doesn't have to know which field they're
                  thinking of. The archive picker drives both the server
                  fetch (whether to include archived rows at all) and the
                  client narrowing (active-only / archived-only / both). */}
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <div className="lg:col-span-3">
                  <label
                    htmlFor={`assessment-search-${id}`}
                    className="sr-only"
                  >
                    Search assessments
                  </label>
                  <input
                    id={`assessment-search-${id}`}
                    type="search"
                    placeholder="Search by name, project, mode, or status…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
                <div>
                  <label
                    htmlFor={`assessment-archive-filter-${id}`}
                    className="sr-only"
                  >
                    Archive state
                  </label>
                  <select
                    id={`assessment-archive-filter-${id}`}
                    value={archiveFilter}
                    onChange={(e) =>
                      setArchiveFilter(e.target.value as ArchiveFilter)
                    }
                    className="w-full rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {ARCHIVE_FILTER_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label
                    htmlFor={`assessment-status-filter-${id}`}
                    className="sr-only"
                  >
                    Status
                  </label>
                  <select
                    id={`assessment-status-filter-${id}`}
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="w-full rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {STATUS_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                {hasActiveFilter ? (
                  <button
                    type="button"
                    onClick={() => {
                      setArchiveFilter("active");
                      setStatusFilter("ALL");
                      setSearchQuery("");
                    }}
                    className="justify-self-start text-xs font-medium text-primary underline-offset-2 hover:underline sm:col-span-2 lg:col-span-3"
                  >
                    Clear filters
                  </button>
                ) : null}
              </div>
            </div>
          </CardHeader>
          {filteredAssessments.length > 0 ? (
            <CardContent className="space-y-2">
              {filteredAssessments.map((a) => {
                const isArchived = a.archivedAt !== null;
                // Active rows link to the per-assessment landing page
                // which hosts the section nav + summary. Archived rows
                // are non-navigable — every detail route 404s until the
                // row is restored — so they render as a dimmed div
                // with Restore / Delete still in reach.
                const summary = (
                  <div className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 font-medium">
                        <span className="truncate">
                          {a.assessmentType.name}
                        </span>
                        {isArchived ? (
                          <span className="shrink-0 rounded-full border border-muted-foreground/30 bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            Archived
                          </span>
                        ) : null}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {a.mode} · {a.status}
                        {a.projectContext?.projectName
                          ? ` · ${a.projectContext.projectName}`
                          : ""}
                      </p>
                    </div>
                    {canMutate ? (
                      <AssessmentRowActions
                        engagementId={data.id}
                        assessmentId={a.id}
                        archivedAt={a.archivedAt}
                      />
                    ) : !isArchived ? (
                      <span aria-hidden className="text-muted-foreground">
                        →
                      </span>
                    ) : null}
                  </div>
                );
                const baseClass = "block rounded-md border transition-colors";
                return isArchived ? (
                  <div
                    key={a.id}
                    className={`${baseClass} cursor-default opacity-70`}
                    aria-label={`${a.assessmentType.name} (archived — restore to view)`}
                  >
                    {summary}
                  </div>
                ) : (
                  <Link
                    key={a.id}
                    href={`/engagements/${data.id}/assessments/${a.id}`}
                    className={`${baseClass} hover:bg-muted/40`}
                  >
                    {summary}
                  </Link>
                );
              })}
            </CardContent>
          ) : data.assessments.length > 0 && hasActiveFilter ? (
            // Server returned rows but every one was filtered out.
            // Distinct from "no assessments yet" — we want the user to
            // realise the filters are why the list looks empty.
            <CardContent>
              <p className="rounded-md border border-dashed bg-muted/30 px-3 py-4 text-center text-sm text-muted-foreground">
                No assessments match the current filters.
              </p>
            </CardContent>
          ) : null}
        </Card>

        <TeamCard
          engagementId={id}
          members={data.members}
          canEdit={canMutate}
        />
      </div>
    </div>
  );
}

const ENGAGEMENT_ROLES = ["OWNER", "CONTRIBUTOR", "REVIEWER", "VIEWER"] as const;
type EngagementRole = (typeof ENGAGEMENT_ROLES)[number];

interface TeamMember {
  userId: string;
  role: EngagementRole;
  user: { id: string; name: string | null; email: string };
}

/**
 * Team card on the engagement detail page. Read-only for non-owners
 * (CONTRIBUTOR / REVIEWER / VIEWER); fully editable for OWNER + ADMIN.
 *
 * Edit affordances:
 *   - Add member: type-ahead over users not already on the engagement
 *     (returned by `searchAddableMembers`), defaulting new rows to
 *     CONTRIBUTOR.
 *   - Per-row role picker: dropdown of engagement roles.
 *   - Per-row remove with two-click confirm (matches the assessment
 *     archive UX so destructive paths feel consistent).
 *
 * Server enforces the same rules independently — last-owner removal
 * and role demotion both throw BAD_REQUEST.
 */
function TeamCard({
  engagementId,
  members,
  canEdit,
}: {
  engagementId: string;
  members: TeamMember[];
  canEdit: boolean;
}) {
  const utils = trpc.useUtils();
  const invalidate = () =>
    Promise.all([
      utils.engagement.getById.invalidate({ id: engagementId }),
      utils.engagement.getById.invalidate({
        id: engagementId,
        includeArchived: true,
      }),
    ]);

  const updateRole = trpc.engagement.updateMemberRole.useMutation({
    onSuccess: invalidate,
  });
  const removeMember = trpc.engagement.removeMember.useMutation({
    onSuccess: invalidate,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Team</CardTitle>
        <CardDescription>
          {members.length} member{members.length === 1 ? "" : "s"}
          {canEdit ? null : (
            <span className="ml-2 text-xs italic">
              · view-only — only the owner or an admin can edit
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {canEdit ? (
          <AddMemberForm engagementId={engagementId} onAdded={invalidate} />
        ) : null}

        <div className="space-y-2">
          {members.map((m) => (
            <MemberRow
              key={m.userId}
              member={m}
              canEdit={canEdit}
              onRoleChange={(role) =>
                updateRole.mutate({
                  engagementId,
                  userId: m.userId,
                  role,
                })
              }
              onRemove={() =>
                removeMember.mutate({ engagementId, userId: m.userId })
              }
              roleBusy={
                updateRole.isPending &&
                updateRole.variables?.userId === m.userId
              }
              removeBusy={
                removeMember.isPending &&
                removeMember.variables?.userId === m.userId
              }
              error={
                updateRole.variables?.userId === m.userId
                  ? (updateRole.error?.message ?? null)
                  : removeMember.variables?.userId === m.userId
                    ? (removeMember.error?.message ?? null)
                    : null
              }
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function MemberRow({
  member,
  canEdit,
  onRoleChange,
  onRemove,
  roleBusy,
  removeBusy,
  error,
}: {
  member: TeamMember;
  canEdit: boolean;
  onRoleChange: (role: EngagementRole) => void;
  onRemove: () => void;
  roleBusy: boolean;
  removeBusy: boolean;
  error: string | null | undefined;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  return (
    <div className="rounded-md border px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">
            {member.user.name ?? member.user.email}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {member.user.email}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canEdit ? (
            <select
              value={member.role}
              disabled={roleBusy || removeBusy}
              onChange={(e) =>
                onRoleChange(e.target.value as EngagementRole)
              }
              className="rounded-md border border-input bg-background px-2 py-1 text-xs"
              aria-label="Role"
            >
              {ENGAGEMENT_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-xs font-medium text-muted-foreground">
              {member.role}
            </span>
          )}
          {canEdit ? (
            confirmRemove ? (
              <>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={removeBusy}
                  onClick={onRemove}
                >
                  Confirm remove
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={removeBusy}
                  onClick={() => setConfirmRemove(false)}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                disabled={roleBusy || removeBusy}
                onClick={() => setConfirmRemove(true)}
              >
                Remove
              </Button>
            )
          ) : null}
        </div>
      </div>
      {error ? (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function AddMemberForm({
  engagementId,
  onAdded,
}: {
  engagementId: string;
  onAdded: () => void;
}) {
  const [query, setQuery] = useState("");
  const [showResults, setShowResults] = useState(false);
  const search = trpc.engagement.searchAddableMembers.useQuery(
    { engagementId, query: query.trim() || undefined },
    { enabled: showResults },
  );
  const addMember = trpc.engagement.addMember.useMutation({
    onSuccess: () => {
      setQuery("");
      setShowResults(false);
      onAdded();
    },
  });

  return (
    <div className="space-y-2">
      <Input
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setShowResults(true);
        }}
        onFocus={() => setShowResults(true)}
        placeholder="Add member by name or email…"
        aria-label="Search users to add"
      />
      {showResults ? (
        <div className="rounded-md border bg-card">
          {search.isLoading ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              Searching…
            </p>
          ) : !search.data || search.data.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              No matching users.
            </p>
          ) : (
            <ul className="max-h-48 divide-y overflow-auto">
              {search.data.map((u) => (
                <li
                  key={u.id}
                  className="flex items-center justify-between px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {u.name ?? u.email}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {u.email}
                      {u.role === "ADMIN" ? " · admin" : ""}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={addMember.isPending}
                    onClick={() =>
                      addMember.mutate({ engagementId, userId: u.id })
                    }
                  >
                    {addMember.isPending && addMember.variables?.userId === u.id
                      ? "Adding…"
                      : "Add"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {addMember.error ? (
        <p className="text-xs text-destructive" role="alert">
          {addMember.error.message}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Admin-only "Delete engagement" affordance. Hidden for non-admins,
 * hidden for engagements that aren't in `ARCHIVED` status (matches the
 * server-side gate). Uses the same two-click confirm pattern as the
 * assessment delete button so destructive paths feel consistent.
 *
 * On success, navigates back to the engagements list — the current
 * page is about to 404 anyway.
 */
function DeleteEngagementControl({
  engagementId,
  status,
}: {
  engagementId: string;
  status: string;
}) {
  const router = useRouter();
  const { data: sessionData } = useSession();
  const utils = trpc.useUtils();
  const [confirm, setConfirm] = useState(false);
  const del = trpc.engagement.delete.useMutation({
    onSuccess: async () => {
      await utils.engagement.list.invalidate();
      router.push("/engagements");
    },
  });

  const isAdmin = sessionData?.user?.role === "ADMIN";
  if (!isAdmin || status !== "ARCHIVED") return null;

  if (!confirm) {
    return (
      <Button
        type="button"
        variant="ghost"
        className="text-destructive hover:text-destructive"
        onClick={() => setConfirm(true)}
      >
        Delete
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="destructive"
        disabled={del.isPending}
        onClick={() => del.mutate({ id: engagementId })}
      >
        {del.isPending ? "Deleting…" : "Really delete?"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        disabled={del.isPending}
        onClick={() => setConfirm(false)}
      >
        Cancel
      </Button>
      {del.error ? (
        <span className="text-xs text-destructive" role="alert">
          {del.error.message}
        </span>
      ) : null}
    </div>
  );
}
