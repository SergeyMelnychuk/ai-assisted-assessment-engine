import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Derive a GitHub-style slug from the plain-text content of a heading.
 * We don't use `rehype-slug` because adding a dep for a single heading
 * component is overkill — this mirrors what the standard plugin does:
 * drop leading numbering ("2. "), lowercase, non-alphanum → hyphen,
 * collapse runs, trim.
 */
function slugifyChildren(node: ReactNode): string {
  const parts: string[] = [];
  const walk = (n: ReactNode): void => {
    if (typeof n === "string" || typeof n === "number") {
      parts.push(String(n));
    } else if (Array.isArray(n)) {
      n.forEach(walk);
    } else if (n && typeof n === "object" && "props" in n) {
      // React element — recurse into its children.
      walk((n as { props: { children?: ReactNode } }).props.children);
    }
  };
  walk(node);
  return parts
    .join("")
    .toLowerCase()
    .replace(/^\s*\d+\.\s+/, "") // drop "2. " numbering prefix
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Renders the admin guide's markdown with styling consistent with the
 * rest of the admin surface. We don't rely on @tailwindcss/typography
 * (not installed in this project) — the element map below handles the
 * small set of tags our operator guides actually use.
 *
 * Server component: we import `react-markdown` directly and pass the
 * body string through. No client hydration is needed since the content
 * is static for a given request.
 */

const components: Components = {
  h1: ({ children }) => (
    <h1 className="mt-2 mb-4 border-b pb-2 text-2xl font-semibold tracking-tight">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2
      id={slugifyChildren(children)}
      className="mt-8 mb-3 scroll-mt-24 text-xl font-semibold tracking-tight"
    >
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3
      id={slugifyChildren(children)}
      className="mt-6 mb-2 scroll-mt-24 text-base font-semibold"
    >
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-4 mb-2 text-sm font-semibold">{children}</h4>
  ),
  p: ({ children }) => (
    <p className="my-3 text-sm leading-6 text-foreground/90">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="my-3 list-disc space-y-1 pl-6 text-sm text-foreground/90">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-3 list-decimal space-y-1 pl-6 text-sm text-foreground/90">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-6">{children}</li>,
  a: ({ href, children }) => (
    <a
      href={href}
      className="text-primary underline-offset-2 hover:underline"
      target={href?.startsWith("http") ? "_blank" : undefined}
      rel={href?.startsWith("http") ? "noopener noreferrer" : undefined}
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-4 rounded-r-md border-l-4 border-primary/60 bg-muted/40 px-4 py-2 text-sm text-foreground/80">
      {children}
    </blockquote>
  ),
  code: ({ className, children, ...rest }) => {
    const isBlock = typeof className === "string" && className.startsWith("language-");
    if (isBlock) {
      return (
        <code
          className={`${className} font-mono text-xs`}
          {...rest}
        >
          {children}
        </code>
      );
    }
    return (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-4 overflow-x-auto rounded-md border bg-muted/60 p-3 text-xs leading-5">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="border-b bg-muted/40 text-left">{children}</thead>
  ),
  th: ({ children }) => (
    <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b px-3 py-2 align-top">{children}</td>
  ),
  hr: () => <hr className="my-8 border-border" />,
  strong: ({ children }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
};

export function GuideMarkdown({ body }: { body: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {body}
    </ReactMarkdown>
  );
}
