import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import type { ReactNode } from "react";

// Server-side role gate for every /admin/* page. The sidebar already hides
// admin nav for non-ADMINs, but this is the authoritative check — a direct
// URL visit or a stale rendered link must be refused here, not only in UI.
export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await getServerSession(authOptions);
  if (!session?.user || session.user.role !== "ADMIN") {
    // Bounce back to the landing page rather than /login — they're signed
    // in, just not privileged. (/login would loop.)
    redirect("/");
  }
  return <>{children}</>;
}
