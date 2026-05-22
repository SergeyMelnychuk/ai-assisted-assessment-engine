"use client";

import Link from "next/link";
import type { Session } from "next-auth";
import { useState, useEffect } from "react";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { SidebarNav } from "./sidebar-nav";
import { UserBlock } from "./user-block";

// Slide-in drawer used on mobile (< md). Desktop layout hides both the
// trigger and the drawer itself.
export function MobileDrawer({ user }: { user: Session["user"] }) {
  const [open, setOpen] = useState(false);

  // Close the drawer if the viewport grows into `md:` where the static
  // sidebar takes over — avoids a stranded open drawer after resize.
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 768px)");
    const handler = (e: MediaQueryListEvent) => {
      if (e.matches) setOpen(false);
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  // Prevent body scroll while the drawer covers the viewport.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        aria-expanded={open}
        aria-controls="mobile-drawer"
        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-input bg-background text-foreground transition hover:bg-muted md:hidden"
      >
        <Menu className="h-4 w-4" aria-hidden />
      </button>

      {/* Backdrop */}
      <div
        aria-hidden
        onClick={() => setOpen(false)}
        className={cn(
          "fixed inset-0 z-40 bg-black/40 transition-opacity md:hidden",
          open
            ? "opacity-100"
            : "pointer-events-none opacity-0",
        )}
      />

      {/* Panel */}
      <aside
        id="mobile-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r bg-background shadow-lg transition-transform md:hidden",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-14 items-center justify-between border-b px-4">
          <Link
            href="/overview"
            onClick={() => setOpen(false)}
            className="flex items-baseline gap-1 text-foreground"
            aria-label="Assessment Co-Pilot"
          >
            <span className="text-base font-semibold tracking-tight">
              Assessment
            </span>
            <span className="text-base font-semibold tracking-tight text-primary">
              Co-Pilot
            </span>
          </Link>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close navigation"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-4">
          <SidebarNav role={user.role} onNavigate={() => setOpen(false)} />
        </div>

        <div className="border-t p-3">
          <UserBlock user={user} />
        </div>
      </aside>
    </>
  );
}
