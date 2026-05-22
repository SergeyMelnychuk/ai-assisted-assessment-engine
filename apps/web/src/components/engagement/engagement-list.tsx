"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { buttonVariants } from "@/components/ui/button";

// Statuses come from the EngagementStatus Prisma enum. Hardcoding the
// labels here avoids a server round-trip just to render filter chips;
// if the enum changes, type-check on `status === s` will catch drift.
const STATUS_FILTERS = ["DRAFT", "ACTIVE", "COMPLETED", "ARCHIVED"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

export function EngagementList() {
  const { data, isLoading, error } = trpc.engagement.list.useQuery();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter | "ALL">(
    "ALL",
  );

  // Client-side filter: the list is bounded to engagements the user can
  // see, which is small (tens, not thousands). No need for a server-side
  // search procedure yet.
  const filtered = useMemo(() => {
    if (!data) return data;
    const q = query.trim().toLowerCase();
    return data.filter((eng) => {
      if (statusFilter !== "ALL" && eng.status !== statusFilter) return false;
      if (!q) return true;
      const haystack = [
        eng.name,
        eng.clientName,
        eng.industry ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [data, query, statusFilter]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Card className="border-destructive/40 bg-destructive/5">
        <CardHeader>
          <CardTitle className="text-destructive">
            Couldn&apos;t load engagements
          </CardTitle>
          <CardDescription className="text-destructive/80">
            {error.message}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!data || data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No engagements yet</CardTitle>
          <CardDescription>
            Create your first engagement to start gathering discovery
            artifacts and running assessments.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/engagements/new" className={buttonVariants()}>
            Create engagement
          </Link>
        </CardContent>
      </Card>
    );
  }

  const visible = filtered ?? [];
  const noMatches = visible.length === 0;

  return (
    <div className="space-y-4">
      <FilterBar
        query={query}
        onQueryChange={setQuery}
        status={statusFilter}
        onStatusChange={setStatusFilter}
        total={data.length}
        shown={visible.length}
      />
      {noMatches ? (
        <Card>
          <CardHeader>
            <CardTitle>No matches</CardTitle>
            <CardDescription>
              Try a different search or clear the status filter.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <ul className="space-y-3">
          {visible.map((eng) => (
        <li key={eng.id}>
          <Link
            href={`/engagements/${eng.id}`}
            className="block rounded-lg outline-none transition focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <Card className="transition-colors hover:bg-muted/30">
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="truncate">{eng.name}</CardTitle>
                    <CardDescription className="truncate">
                      {eng.clientName}
                      {eng.industry ? ` · ${eng.industry}` : ""}
                    </CardDescription>
                  </div>
                  <span
                    className="shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium"
                    aria-label={`Status: ${eng.status}`}
                  >
                    {eng.status}
                  </span>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">
                  {eng._count.assessments} assessment
                  {eng._count.assessments === 1 ? "" : "s"} · Created{" "}
                  {new Date(eng.createdAt).toLocaleDateString(undefined, {
                    dateStyle: "medium",
                  })}
                </p>
              </CardContent>
            </Card>
          </Link>
        </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterBar({
  query,
  onQueryChange,
  status,
  onStatusChange,
  total,
  shown,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  status: StatusFilter | "ALL";
  onStatusChange: (s: StatusFilter | "ALL") => void;
  total: number;
  shown: number;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search by name, client, or industry…"
          className="max-w-sm"
          aria-label="Search engagements"
        />
        <div className="flex flex-wrap items-center gap-1">
          <FilterChip
            active={status === "ALL"}
            onClick={() => onStatusChange("ALL")}
            label="All"
          />
          {STATUS_FILTERS.map((s) => (
            <FilterChip
              key={s}
              active={status === s}
              onClick={() => onStatusChange(s)}
              label={s.replace("_", " ")}
            />
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Showing {shown} of {total}
      </p>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors " +
        (active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-background text-muted-foreground hover:bg-muted")
      }
    >
      {label}
    </button>
  );
}
