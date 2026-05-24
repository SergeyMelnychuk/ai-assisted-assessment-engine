import type { Metadata } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { Providers } from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Assessment Co-Pilot",
  description:
    "AI-Powered Assessment Co-Pilot for Discovery, Audit, and Solution Shaping",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Fetch the session server-side and hand it to SessionProvider so first
  // paint reflects the true auth state (no unauthenticated flash).
  const session = await getServerSession(authOptions);

  return (
    // `suppressHydrationWarning` on <body>: browser extensions
    // (Grammarly's `data-gr-ext-installed` + `data-new-gr-c-s-check-loaded`,
    // ColorZilla, LastPass, etc.) inject attributes onto the body after
    // the page loads on the client. The server-rendered HTML doesn't
    // carry those, so React's hydration step prints a noisy mismatch
    // warning. The flag scopes the warning suppression to attribute
    // diffs ON THIS ELEMENT ONLY — children still hydrate strictly,
    // so real bugs in the app tree still surface.
    <html lang="en">
      <body className="min-h-screen antialiased" suppressHydrationWarning>
        <Providers session={session}>{children}</Providers>
      </body>
    </html>
  );
}
