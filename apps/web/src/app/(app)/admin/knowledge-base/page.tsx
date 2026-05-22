import Link from "next/link";
import { db } from "@/server/db";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { KnowledgeArtifactRowActions } from "@/components/admin/knowledge-artifact-row-actions";
import { domainLabel } from "@/lib/domain-labels";
import { TYPE_LABELS, ARTIFACT_TYPES } from "./type-labels";

/**
 * Admin knowledge-base inventory. Groups every `KnowledgeArtifact` row
 * by type and exposes per-row Edit / Activate / Delete controls plus a
 * "New {type}" button on each group. Editing bumps the artifact's
 * `version` so downstream consumers (analysis, scoring, estimation,
 * question seeding) behave the same way they would after a `pnpm
 * db:seed` re-run.
 *
 * The seed workflow (`packages/knowledge-seed/*.json`) is still the
 * source of truth for first-load and CI — the UI is for targeted
 * tweaks between seeds.
 */

export const dynamic = "force-dynamic";

/**
 * A lot of seed artifacts store a dotted/kebab slug in the `name`
 * column (e.g. `questions.nfrs.baseline`, `framework.architecture-
 * assessment`) — it's the idempotency key the seeder upserts on. That
 * reads as gibberish in the admin UI, so we detect slug-style names
 * and treat the `description` as the primary label instead. Names that
 * are already human ("Standard Role Catalog") keep the normal layout.
 */
function isSlugLikeName(name: string): boolean {
  // all-lowercase, with dots / underscores / hyphens as separators —
  // i.e. "questions.x.y" or "framework.foo-bar" or "snake_case_name".
  if (!name) return false;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) return false;
  return /[._-]/.test(name);
}

export default async function KnowledgeBasePage() {
  const artifacts = await db.knowledgeArtifact.findMany({
    orderBy: [{ artifactType: "asc" }, { name: "asc" }],
    select: {
      id: true,
      artifactType: true,
      name: true,
      description: true,
      domain: true,
      version: true,
      isActive: true,
      updatedAt: true,
    },
  });

  // Group by type — use a Map to preserve the order we got from the query.
  const byType = new Map<string, typeof artifacts>();
  for (const a of artifacts) {
    const list = byType.get(a.artifactType) ?? [];
    list.push(a);
    byType.set(a.artifactType, list);
  }

  // Include every known type so admins can "New ..." an artifact even
  // for types that have zero rows yet. Unseeded types render as an
  // empty card with a Create button.
  const allTypes = new Set<string>([
    ...ARTIFACT_TYPES,
    ...Array.from(byType.keys()),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Knowledge Base
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Templates and patterns the AI pipelines pull from when proposing
            questions, risks, recommendations, and scores. {artifacts.length}{" "}
            artifact{artifacts.length === 1 ? "" : "s"} currently stored across{" "}
            {byType.size} type{byType.size === 1 ? "" : "s"}.
          </p>
        </div>
        <Link href="/admin/knowledge-base/new">
          <Button type="button">New artifact</Button>
        </Link>
      </div>

      {Array.from(allTypes)
        .sort()
        .map((type) => {
          const items = byType.get(type) ?? [];
          const meta = TYPE_LABELS[type] ?? {
            label: type.toLowerCase().replace(/_/g, " "),
            description: "",
          };
          return (
            <Card key={type}>
              <CardHeader>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <CardTitle className="text-base">
                    {meta.label}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {items.length} item{items.length === 1 ? "" : "s"}
                    </span>
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/admin/knowledge-base/new?type=${encodeURIComponent(
                        type,
                      )}`}
                    >
                      <Button type="button" variant="secondary" size="sm">
                        New {meta.label.toLowerCase()}
                      </Button>
                    </Link>
                  </div>
                </div>
                {meta.description ? (
                  <CardDescription>{meta.description}</CardDescription>
                ) : null}
              </CardHeader>
              <CardContent>
                {meta.seedPath ? (
                  <p className="mb-3 text-xs text-muted-foreground">
                    Seed source:{" "}
                    <code className="rounded bg-muted px-1 py-0.5">
                      {meta.seedPath}
                    </code>
                  </p>
                ) : null}
                {items.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No artifacts of this type yet.
                  </p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {items.map((item) => (
                      <li
                        key={item.id}
                        className="flex flex-wrap items-start justify-between gap-3 rounded-md border px-3 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          {(() => {
                            const slugName = isSlugLikeName(item.name);
                            // If the seed stored a slug in `name`, the
                            // `description` is the real human title. Fall
                            // back to a best-effort beautifier of the slug
                            // when no description is present.
                            const primary =
                              slugName && item.description
                                ? item.description
                                : item.name;
                            const showSlugChip = slugName;
                            return (
                              <>
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-medium">{primary}</span>
                                  {item.domain ? (
                                    <span className="inline-flex items-center rounded-full border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                                      {domainLabel(item.domain)}
                                    </span>
                                  ) : null}
                                  {!item.isActive ? (
                                    <span className="inline-flex items-center rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
                                      inactive
                                    </span>
                                  ) : null}
                                  <span className="text-xs text-muted-foreground">
                                    v{item.version}
                                  </span>
                                  <span className="text-xs text-muted-foreground">
                                    updated{" "}
                                    {new Date(item.updatedAt).toLocaleDateString(
                                      undefined,
                                      { dateStyle: "medium" },
                                    )}
                                  </span>
                                </div>
                                {showSlugChip ? (
                                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                    <code className="rounded bg-muted px-1 py-0.5 text-[0.7rem]">
                                      {item.name}
                                    </code>
                                  </p>
                                ) : item.description ? (
                                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                    {item.description}
                                  </p>
                                ) : null}
                              </>
                            );
                          })()}
                        </div>
                        <KnowledgeArtifactRowActions
                          id={item.id}
                          isActive={item.isActive}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          );
        })}

      <Card>
        <CardHeader>
          <CardTitle>Editing & seeding</CardTitle>
          <CardDescription>
            The UI edits live rows directly. `pnpm db:seed` remains the
            source-of-truth for initial load and CI.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            The seed under{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              packages/knowledge-seed/
            </code>{" "}
            is idempotent — re-running{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              pnpm db:seed
            </code>{" "}
            will upsert any artifact whose <code>name + artifactType</code>{" "}
            matches a seed file and bump its{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              version
            </code>
            . Edits made in this UI also bump the version; a subsequent seed
            run will overwrite your edits if the seed file carries the same
            name. Use unique names for UI-only artifacts to avoid that.
          </p>
          <p>
            Artifacts with the{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              inactive
            </code>{" "}
            flag are hidden from every pipeline (question seeding, analysis,
            scoring, estimation).
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
