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
        // `loggerLink` is disabled in dev.
        //
        // Why: it prints every tRPC call to the browser console, and
        // transient empty-input requests during regeneration races
        // (where a useQuery hook briefly mounts with an undefined
        // id before the parent's state settles) get logged as
        // `console.error`, which the Next.js dev overlay catches and
        // turns into a red popup. We chased this through several
        // layers — component-level wrappers, `enabled` hooks,
        // string-matching filters in a custom `console` shim — and
        // none of them reliably caught every path. tRPC v11's
        // loggerLink formats args in a way that's hard to filter
        // structurally.
        //
        // The pragmatic call: drop the loggerLink in dev. Every
        // request/response is already visible in the browser's
        // Network tab (with status code, timing, and payload), and
        // real errors in calling code still throw / log normally.
        // In prod, keep the error-only behaviour so server errors
        // make it to wherever console.error is collected.
        loggerLink({
          enabled: (opts) =>
            process.env.NODE_ENV !== "development" &&
            opts.direction === "down" &&
            opts.result instanceof Error,
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
