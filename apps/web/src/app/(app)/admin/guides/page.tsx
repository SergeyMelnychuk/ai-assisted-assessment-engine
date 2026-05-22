import Link from "next/link";
import { ChevronRight, Router } from "lucide-react";

/**
 * Admin guides index.
 *
 * Entry point for operator-facing documentation. Each card links to a
 * subpage that renders a markdown source from `docs/guides/` (fetched
 * from GitHub raw at request time, with a bundled-file fallback).
 *
 * New guides: drop the markdown under `docs/guides/`, add a subpage
 * under `app/(app)/admin/guides/<slug>/page.tsx` that loads it, and
 * add an entry to `GUIDES` below. The nav only links to this index —
 * subpages auto-surface through these cards.
 */

interface GuideEntry {
  slug: string;
  title: string;
  description: string;
  icon: typeof Router;
}

const GUIDES: readonly GuideEntry[] = [
  {
    slug: "ai-router",
    title: "AI Router",
    description:
      "End-to-end guide to the AI Router: what the router does, when to pin overrides, fallback chains, provider credentials, safety rails, and FAQ.",
    icon: Router,
  },
];

export default function AdminGuidesIndexPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Admin guides</h1>
        <p className="text-sm text-muted-foreground">
          Operator handbook. Each guide is rendered from a markdown file
          in{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            docs/guides/
          </code>{" "}
          so edits ship as PRs and propagate without a redeploy.
        </p>
      </header>

      <ul className="grid gap-3 md:grid-cols-2">
        {GUIDES.map((g) => {
          const Icon = g.icon;
          return (
            <li key={g.slug}>
              <Link
                href={`/admin/guides/${g.slug}`}
                className="group flex h-full items-start gap-3 rounded-lg border bg-background p-4 shadow-sm transition-colors hover:border-primary/40 hover:bg-muted/30"
              >
                <div className="mt-0.5 rounded-md border bg-muted/40 p-2 text-muted-foreground group-hover:text-foreground">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-base font-semibold">{g.title}</h2>
                    <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {g.description}
                  </p>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
