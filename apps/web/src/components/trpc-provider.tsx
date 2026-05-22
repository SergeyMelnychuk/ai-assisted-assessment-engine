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
        loggerLink({
          enabled: (opts) =>
            process.env.NODE_ENV === "development" ||
            (opts.direction === "down" && opts.result instanceof Error),
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
