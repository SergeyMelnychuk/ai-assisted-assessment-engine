"use client";

import type { ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ClusteredChunkPreview } from "./evidence-chunk-preview";
import { domainLabel } from "@/lib/domain-labels";

/**
 * Evidence Explorer (Phase 3 Week 7, ADR-0011 + post-MVP polish).
 *
 * Semantic search over chunks. Domain dropdown populated from the
 * assessment's actual domain coverage; an optional source-document
 * filter narrows the search to one or more Documents. Deep links
 * from finding / risk / recommendation pages pre-fill `initialQuery`
 * + `initialDomain` so the reviewer lands directly on results.
 *
 * A document index lives on the standalone Documents page — kept
 * here would duplicate that view, so the Explorer is search-only.
 */
export function EvidenceExplorer({
  assessmentId,
  initialQuery,
  initialDomain,
}: {
  assessmentId: string;
  /**
   * Pre-fills the search box (cross-page deep linking). When
   * present the query is submitted immediately so the reviewer
   * lands on results, not an empty page.
   */
  initialQuery?: string;
  /** Pre-fills the domain filter from the deep link. */
  initialDomain?: string;
}): ReactElement {
  return (
    <SearchTab
      assessmentId={assessmentId}
      initialQuery={initialQuery}
      initialDomain={initialDomain}
    />
  );
}

// ─── Search tab ────────────────────────────────────────────────────

function SearchTab({
  assessmentId,
  initialQuery,
  initialDomain,
}: {
  assessmentId: string;
  initialQuery?: string;
  initialDomain?: string;
}) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [submittedQuery, setSubmittedQuery] = useState<string | null>(
    initialQuery && initialQuery.trim().length > 0 ? initialQuery.trim() : null,
  );
  const [domain, setDomain] = useState<string>(initialDomain ?? "");
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
  // Cluster ids selected for bulk re-tagging (Option C).
  const [selectedClusterIds, setSelectedClusterIds] = useState<string[]>([]);

  // Domain dropdown is driven by the assessment's `activeDomains` list
  // so every domain the user set up appears, with chunk counts. The
  // documents picker only surfaces rows that actually have chunks.
  const domainsQuery = trpc.evidenceExplorer.listDomains.useQuery({
    assessmentId,
  });
  const documentsQuery = trpc.evidenceExplorer.listDocuments.useQuery({
    assessmentId,
  });
  const documentOptions = useMemo(
    () => documentsQuery.data?.filter((d) => d.chunkCount > 0) ?? [],
    [documentsQuery.data],
  );
  const selectedDocs = useMemo(
    () => documentOptions.filter((d) => selectedDocIds.includes(d.id)),
    [documentOptions, selectedDocIds],
  );

  const searchQuery = trpc.evidenceExplorer.search.useQuery(
    {
      assessmentId,
      query: submittedQuery ?? "",
      domain: domain || undefined,
      documentIds:
        selectedDocIds.length > 0 ? selectedDocIds : undefined,
    },
    {
      // Don't fire until the user has submitted — retrieval is a paid
      // call (embed), no auto-query-on-keystroke.
      enabled: submittedQuery !== null && submittedQuery.length > 0,
    },
  );

  const noDocs = documentsQuery.data?.length === 0;

  return (
    <div className="grid gap-4 md:grid-cols-[280px_1fr]">
      <aside className="space-y-3">
        <FilterBlock label="Domain">
          <select
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            className="block w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          >
            <option value="">All domains</option>
            {domainsQuery.data?.domains.map((d) => (
              <option key={d.domain} value={d.domain}>
                {domainLabel(d.domain)}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-muted-foreground">
            Picking a domain searches chunks tagged for that domain
            plus the shared bucket of uncategorised chunks — the same
            scope the analysis engine sees.
          </p>
        </FilterBlock>

        <FilterBlock label="Source documents">
          <DocumentMultiSelect
            options={documentOptions}
            selected={selectedDocs}
            onAdd={(id) =>
              setSelectedDocIds((prev) =>
                prev.includes(id) ? prev : [...prev, id],
              )
            }
            onRemove={(id) =>
              setSelectedDocIds((prev) => prev.filter((x) => x !== id))
            }
            disabled={noDocs}
          />
          <p className="text-[11px] text-muted-foreground">
            Type to filter, click to add. Leave empty to search every
            document. Picking specific documents disables the domain
            widen-fallback.
          </p>
        </FilterBlock>
      </aside>

      <section className="space-y-3">
        {/* Wrap the search form in the same FilterBlock shell the
            sidebar uses so the input baseline lines up with the
            Domain dropdown across the columns. Without the matching
            label-row the right side floated higher by ~24px. */}
        <FilterBlock label="Query">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setSubmittedQuery(query.trim());
            }}
          >
            <Input
              placeholder="Search evidence (e.g. authentication, SLA, rollback)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Button type="submit" disabled={query.trim().length === 0}>
              Search
            </Button>
          </form>
        </FilterBlock>
        {submittedQuery === null ? (
          <EmptyHint
            hasDocs={!noDocs && documentsQuery.data !== undefined}
          />
        ) : null}

        {searchQuery.isLoading && <Skeleton className="h-24 w-full" />}
        {searchQuery.error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {searchQuery.error.message}
          </p>
        )}
        {searchQuery.data && searchQuery.data.length === 0 && submittedQuery && (
          <p className="text-sm text-muted-foreground">
            No evidence matched &ldquo;{submittedQuery}&rdquo;
            {domain ? ` in domain ${domain}` : ""}
            {selectedDocs.length > 0
              ? ` in ${selectedDocs.length} selected document${selectedDocs.length === 1 ? "" : "s"}`
              : ""}
            .
          </p>
        )}
        {searchQuery.data && searchQuery.data.length > 0 && (
          <div className="space-y-2">
            <RetagToolbar
              assessmentId={assessmentId}
              activeDomains={
                domainsQuery.data?.domains.map((d) => d.domain) ?? []
              }
              selectedClusterIds={selectedClusterIds}
              clusters={searchQuery.data}
              onClear={() => setSelectedClusterIds([])}
              onRetagged={async () => {
                setSelectedClusterIds([]);
                await searchQuery.refetch();
              }}
            />
            {searchQuery.data.map((c) => {
              const checked = selectedClusterIds.includes(c.representativeId);
              return (
                <div
                  key={c.representativeId}
                  className="flex items-start gap-2"
                >
                  <input
                    type="checkbox"
                    aria-label="Select chunk for re-tag"
                    className="mt-3 size-4 shrink-0 rounded border-input"
                    checked={checked}
                    onChange={(e) => {
                      setSelectedClusterIds((prev) =>
                        e.target.checked
                          ? [...prev, c.representativeId]
                          : prev.filter((id) => id !== c.representativeId),
                      );
                    }}
                  />
                  <div className="grow">
                    <ClusteredChunkPreview cluster={c} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

interface DocOption {
  id: string;
  filename: string;
  chunkCount: number;
}

/**
 * Typeahead multi-select for source documents. Mirrors the
 * "filter as you type" pattern from the Browse tab but as a picker:
 * type → filtered list of documents not already selected → click to
 * add. Selected documents render as removable chips above the input.
 *
 * No external dropdown library — a plain input + filtered list is
 * enough for the assessment-scoped corpus (typically <100 docs).
 */
function DocumentMultiSelect({
  options,
  selected,
  onAdd,
  onRemove,
  disabled,
}: {
  options: DocOption[];
  selected: DocOption[];
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
  disabled?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedIds = useMemo(() => new Set(selected.map((d) => d.id)), [selected]);

  // Close-on-outside-click. The container ref wraps both the input and
  // the result list so clicking a result still counts as "inside" and
  // doesn't dismiss the dropdown before `onClick` fires.
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  // Only show suggestions once the user has typed something. The
  // dropdown stays empty on a bare focus so the page doesn't expand
  // into a long list the user didn't ask for.
  const trimmed = filter.trim();
  const matches = useMemo(() => {
    if (!trimmed) return [];
    const q = trimmed.toLowerCase();
    return options
      .filter((d) => !selectedIds.has(d.id))
      .filter((d) => d.filename.toLowerCase().includes(q))
      .slice(0, 8);
  }, [options, selectedIds, trimmed]);

  const showResults = open && !disabled && trimmed.length > 0;

  return (
    <div className="space-y-2" ref={containerRef}>
      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {selected.map((d) => (
            <span
              key={d.id}
              className="inline-flex items-center gap-1 rounded-md border bg-muted px-1.5 py-0.5 text-xs"
            >
              <span className="max-w-[180px] truncate" title={d.filename}>
                {d.filename}
              </span>
              <button
                type="button"
                onClick={() => onRemove(d.id)}
                aria-label={`Remove ${d.filename}`}
                className="text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <Input
        type="search"
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        placeholder={
          disabled
            ? "No documents available"
            : "Type to filter documents…"
        }
        disabled={disabled}
        aria-label="Filter source documents"
      />
      {showResults ? (
        <div className="rounded-md border bg-card">
          {matches.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              No matching documents.
            </p>
          ) : (
            <ul className="max-h-48 divide-y overflow-auto">
              {matches.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted/50"
                    onClick={() => {
                      // Add the picked document but keep the query +
                      // dropdown open. Selected ids are filtered out
                      // of the result list (`selectedIds.has(d.id)`),
                      // so the user can keep clicking matches under
                      // the same query without retyping. Esc / click
                      // outside still closes the dropdown.
                      onAdd(d.id);
                    }}
                  >
                    <span className="truncate">{d.filename}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {d.chunkCount}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function FilterBlock({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </h2>
      {children}
    </div>
  );
}

function EmptyHint({ hasDocs }: { hasDocs: boolean }) {
  return (
    <div className="rounded-md border border-dashed bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
      {hasDocs ? (
        <>
          Type a phrase that describes what you&apos;re looking for —
          semantic search, not keyword. Try &ldquo;rollback
          strategy&rdquo;, &ldquo;PII handling&rdquo;, or &ldquo;SLA
          monitoring&rdquo;. The Browse tab lets you skim documents
          first.
        </>
      ) : (
        <>No evidence yet — upload documents or link a repository.</>
      )}
    </div>
  );
}

/**
 * Bulk re-tag toolbar for the Evidence Explorer search results
 * (Option C). Renders inline above the result list once any
 * checkbox is ticked. The picker is the assessment's active
 * domains plus the catch-all "ingested" bucket (so reviewers can
 * intentionally bounce a chunk back to the shared pool).
 *
 * Server uses the union of `memberIds` across the selected clusters
 * so a single click re-tags every near-duplicate the clusterer
 * merged together.
 */
function RetagToolbar({
  assessmentId,
  activeDomains,
  selectedClusterIds,
  clusters,
  onClear,
  onRetagged,
}: {
  assessmentId: string;
  activeDomains: readonly string[];
  selectedClusterIds: string[];
  clusters: ReadonlyArray<{
    representativeId: string;
    memberIds: string[];
  }>;
  onClear: () => void;
  onRetagged: () => Promise<void> | void;
}) {
  const [target, setTarget] = useState("");
  const retag = trpc.evidenceExplorer.retag.useMutation();

  if (selectedClusterIds.length === 0) return null;

  const evidenceIds = clusters
    .filter((c) => selectedClusterIds.includes(c.representativeId))
    .flatMap((c) => c.memberIds);

  const submit = async () => {
    if (!target) return;
    await retag.mutateAsync({
      assessmentId,
      evidenceIds,
      domain: target,
    });
    setTarget("");
    await onRetagged();
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
      <span className="font-medium">
        {selectedClusterIds.length} selected
      </span>
      <span className="text-xs text-muted-foreground">
        ({evidenceIds.length} chunks incl. near-duplicates)
      </span>
      <select
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        disabled={retag.isPending}
        className="rounded-md border border-input bg-background px-2 py-1 text-xs"
        aria-label="Retag to domain"
      >
        <option value="">Pick a domain…</option>
        {activeDomains.map((d) => (
          <option key={d} value={d}>
            {domainLabel(d)}
          </option>
        ))}
        <option value="ingested">Catch-all (ingested)</option>
      </select>
      <Button
        size="sm"
        onClick={submit}
        disabled={!target || retag.isPending}
      >
        {retag.isPending ? "Re-tagging…" : "Re-tag"}
      </Button>
      <Button size="sm" variant="ghost" onClick={onClear}>
        Clear
      </Button>
      {retag.error ? (
        <span className="text-xs text-destructive">
          {retag.error.message}
        </span>
      ) : null}
    </div>
  );
}
