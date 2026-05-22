import { readFile } from "node:fs/promises";
import path from "node:path";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { GuideMarkdown } from "@/components/admin/guide/guide-markdown";

/**
 * Templates guide — customer-uploadable templates lifecycle.
 *
 * Same loading pattern as the other admin guides:
 *   1. Fetch `docs/guides/templates.md` from GitHub raw so docs-only
 *      edits propagate without a redeploy.
 *   2. Fall back to the file bundled with the deploy when raw is
 *      unreachable (local dev, air-gapped, rate limit).
 *
 * `DOCS_GITHUB_RAW_URL_TEMPLATES` overrides the source URL.
 */

const DEFAULT_RAW_URL =
  "https://raw.githubusercontent.com/SergeyMelnychuk/ai-assisted-assessment-engine/main/docs/guides/templates.md";

export const revalidate = 300;

async function loadGuide(): Promise<{ source: "github" | "local"; body: string }> {
  const url =
    process.env.DOCS_GITHUB_RAW_URL_TEMPLATES ?? DEFAULT_RAW_URL;
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
  const localPath = path.resolve(
    process.cwd(),
    "../../docs/guides/templates.md",
  );
  const body = await readFile(localPath, "utf8");
  return { source: "local", body };
}

export default async function TemplatesGuidePage() {
  let loaded: { source: "github" | "local"; body: string };
  let loadError: string | null = null;
  try {
    loaded = await loadGuide();
  } catch (err) {
    loaded = {
      source: "local",
      body:
        "# Guide unavailable\n\nCould not load the Templates guide from " +
        "GitHub or the bundled fallback. Please check " +
        "`DOCS_GITHUB_RAW_URL_TEMPLATES` or the " +
        "`docs/guides/templates.md` file in the repo.\n",
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
          Templates guide
        </h1>
        {loadError ? (
          <p className="text-sm text-destructive">
            (remote fetch failed: {loadError})
          </p>
        ) : null}
      </header>

      <article className="rounded-lg border bg-background p-6 shadow-sm">
        <GuideMarkdown body={loaded.body} />
      </article>
    </div>
  );
}
