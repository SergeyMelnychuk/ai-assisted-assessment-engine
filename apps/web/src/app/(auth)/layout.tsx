import type { ReactNode } from "react";

// Shared chrome for /login and /register: centered card, no sidebar, no
// authenticated top-bar (those arrive in Task 3).
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          {/* Wordmark — replaces the prior vendor logo image. Plain
           *  text scales cleanly at any density without an asset. */}
          <p className="text-3xl font-semibold tracking-tight">
            Assessment{" "}
            <span className="text-primary">Co-Pilot</span>
          </p>
          <h1 className="mt-3 text-base font-medium tracking-tight text-muted-foreground">
            AI-Powered Discovery &amp; Solution Shaping
          </h1>
        </div>
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          {children}
        </div>
      </div>
    </main>
  );
}
