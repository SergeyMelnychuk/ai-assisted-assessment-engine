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
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Providers session={session}>{children}</Providers>
      </body>
    </html>
  );
}
