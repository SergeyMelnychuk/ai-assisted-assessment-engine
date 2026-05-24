"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, loggerLink } from "@trpc/client";
import superjson from "superjson";
import { trpc } from "@/lib/trpc";

function getBaseUrl() {
  // Browser uses a relative URL so requests inherit the current origin and
  // cookies flow automatically. Server-side (prefetch, testing) would need
  // an absolute URL — we aren't doing SSR prefetching yet, so this branch
  // only matters once a server caller is introduced.
  if (typeof window !== "undefined") return "";
  return process.env.NEXTAUTH_URL ?? "http://localhost:3000";
}

// QueryClient factory. A fresh client per browser tab; React strict-mode
// safe because we lazy-init inside `useState`.
function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Re-fetch when the tab regains focus, but not when the component
        // remounts on every navigation — balances freshness vs. churn.
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        retry: 1,
      },
    },
  });
}

export function TRPCReactProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        // `loggerLink` prints one line per call in dev — removed entirely in
        // prod by the `enabled` check so bundle size isn't impacted.
        //
        // Why we route through a custom `console`: the Next.js dev
        // overlay catches `console.error` calls and turns them into
        // red "Console Error" popups. During a regeneration, React
        // 19's batched state updates can briefly leave a useQuery
        // hook firing with `{ id: undefined }` even when the
        // component-level wrapper intends to skip it (micro-task
        // ordering between the parent's `selectedId` state change
        // and the child's hook teardown). Server-side Zod rightly
        // rejects the `{}` input as BAD_REQUEST; the response comes
        // back as an Error; the loggerLink hands it to
        // `console.error`; the dev overlay pops.
        //
        // We demote BAD_REQUEST log lines to `console.warn` so the
        // overlay stays quiet on these transient races. The lines
        // are still visible in the regular browser console for any
        // dev who wants to inspect them. Every other error class
        // (UNAUTHORIZED, FORBIDDEN, INTERNAL_SERVER_ERROR, …) keeps
        // its red-popup behaviour — those represent real bugs worth
        // surfacing immediately.
        loggerLink({
          enabled: (opts) =>
            process.env.NODE_ENV === "development" ||
            (opts.direction === "down" && opts.result instanceof Error),
          console: {
            log: (...args: unknown[]) => {
              console.log(...args);
            },
            error: (...args: unknown[]) => {
              // The loggerLink passes the formatted line as the first
              // arg and the raw error object as a later arg (NOT
              // embedded in the string). String-matching the joined
              // args misses the code; inspect each arg for a
              // TRPCClientError-shaped object and read `data.code`
              // directly.
              const isBadRequest = args.some((a) => {
                if (!a || typeof a !== "object") return false;
                const data = (a as { data?: { code?: string } }).data;
                return data?.code === "BAD_REQUEST";
              });
              if (isBadRequest) {
                console.warn(...args);
                return;
              }
              console.error(...args);
            },
          } as Console,
        }),
        httpBatchLink({
          url: `${getBaseUrl()}/api/trpc`,
          transformer: superjson,
          // Ensure the NextAuth session cookie is sent on every call. It's
          // the default for same-origin requests, but being explicit future-
          // proofs against cross-origin deployments.
          fetch: (url, options) =>
            fetch(url, { ...options, credentials: "include" }),
        }),
      ],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
