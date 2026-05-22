"use client";

import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";
import type { ReactNode } from "react";
import { TRPCReactProvider } from "@/components/trpc-provider";

// Single client boundary at the root. Nested so tRPC hooks can observe
// session changes (SessionProvider outermost) and everything downstream
// has typed `trpc.*` hooks available.
export function Providers({
  children,
  session,
}: {
  children: ReactNode;
  session: Session | null;
}) {
  return (
    <SessionProvider session={session}>
      <TRPCReactProvider>{children}</TRPCReactProvider>
    </SessionProvider>
  );
}
