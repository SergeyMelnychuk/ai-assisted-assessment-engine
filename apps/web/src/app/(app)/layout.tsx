import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { Sidebar } from "@/components/layout/sidebar";
import { TopBar } from "@/components/layout/top-bar";
import { SidebarStateProvider } from "@/components/layout/sidebar-state";
import type { ReactNode } from "react";

// App shell — wraps every authenticated surface (/engagements/*, /admin/*).
//
// Double enforcement of auth:
//   1. `middleware.ts` blocks unauth requests at the edge.
//   2. This layout re-checks server-side so that a future matcher tweak
//      can't accidentally leak the shell to unauthenticated users.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    redirect("/login");
  }

  // `h-screen` (not `min-h-screen`) locks the shell to the viewport so
  // the sidebar's bottom UserBlock / sign-out button stays in view
  // without scrolling. With `min-h-screen` the outer row grew with
  // page content, pushing the sign-out off-screen and preventing
  // `main.overflow-y-auto` from ever activating. Now the sidebar is a
  // viewport-tall flex column (logo → scrollable nav → UserBlock),
  // and `<main>` is the sole scroll container.
  return (
    <SidebarStateProvider>
      <div className="flex h-screen bg-muted/20">
        <Sidebar user={session.user} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar user={session.user} />
          <main className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-6xl px-4 py-8 md:px-8">
              {children}
            </div>
          </main>
        </div>
      </div>
    </SidebarStateProvider>
  );
}
