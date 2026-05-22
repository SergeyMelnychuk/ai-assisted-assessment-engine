import { readFile } from "node:fs/promises";
import path from "node:path";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { GuideMarkdown } from "@/components/admin/guide/guide-markdown";

/**
 * AI Router guide — end-to-end operator manual.
 *
 * The source of truth is `docs/guides/admin-ai-router.md` in the repo.
 * At request time we:
 *   1. Try to fetch it from GitHub raw so the deployed app shows the
 *      latest merged guide without a redeploy (docs-only updates ship
 *      as merges, not releases).
 *   2. Fall back to the file bundled with the deploy if the fetch
 *      fails (no network, private repo without token, rate limit).
 *      This keeps the page working in local dev and in air-gapped
 *      environments where raw.githubusercontent.com is unreachable.
 *
 * `DOCS_GITHUB_RAW_URL` lets staging point at a branch other than the
 * default when docs changes need to be previewed before merge. Shape:
 *   https://raw.githubusercontent.com/<owner>/<repo>/<ref>/docs/guides/admin-ai-router.md
 */

const DEFAULT_RAW_URL =
  "https://raw.githubusercontent.com/SergeyMelnychuk/ai-assisted-assessment-engine/main/docs/guides/admin-ai-router.md";

// Docs change independently of the build — don't let Next cache them
// indefinitely. 5 min is a reasonable middle ground: fresh enough for
// an operator who just merged a doc fix, slow enough that the raw URL
// doesn't get hammered on every admin page view.
export const revalidate = 300;

async function loadGuide(): Promise<{ source: "github" | "local"; body: string }> {
  const url = process.env.DOCS_GITHUB_RAW_URL ?? DEFAULT_RAW_URL;
  try {
    const res = await fetch(url, { next: { revalidate } });
    if (res.ok) {
      const body = await res.text();
      if (body.trim().length > 0) {
        return { source: "github", body };
      }
    }
  } catch {
    // fall through to local
  }
  // Local fallback: read the bundled copy. `process.cwd()` is the web
  // app root (`apps/web`) in both `next dev` and `next start`.
  const localPath = path.resolve(
    process.cwd(),
    "../../docs/guides/admin-ai-router.md",
  );
  const body = await readFile(localPath, "utf8");
  return { source: "local", body };
}

export default async function AiRouterGuidePage() {
  let loaded: { source: "github" | "local"; body: string };
  let loadError: string | null = null;
  try {
    loaded = await loadGuide();
  } catch (err) {
    loaded = {
      source: "local",
      body:
        "# Guide unavailable\n\nCould not load the admin guide from GitHub " +
        "or the bundled fallback. Please check `DOCS_GITHUB_RAW_URL` or " +
        "the `docs/guides/admin-ai-router.md` file in the repo.\n",
    };
    loadError = err instanceof Error ? err.message : String(err);
  }

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Link
          href="/admin/guides"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" />
          All guides
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          AI Router guide
        </h1>
        <p className="text-sm text-muted-foreground">
          End-to-end reference for operating the AI Router. Source:{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            docs/guides/admin-ai-router.md
          </code>{" "}
          · loaded from <strong>{loaded.source}</strong>.
          {loadError ? (
            <span className="ml-1 text-destructive">
              (remote fetch failed: {loadError})
            </span>
          ) : null}
        </p>
      </header>

      <article className="rounded-lg border bg-background p-6 shadow-sm">
        <GuideMarkdown body={loaded.body} />
      </article>
    </div>
  );
}
