"use client";

import type { Session } from "next-auth";
import { PanelLeft, PanelLeftClose } from "lucide-react";
import { MobileDrawer } from "./mobile-drawer";
import { BrandLogo } from "./brand-logo";
import { useSidebarState } from "./sidebar-state";

/**
 * Top bar. On desktop (>= md) this hosts:
 *   - A sidebar collapse/expand toggle (chevron icon)
 *   - The BrandLogo, but ONLY when the sidebar is collapsed — otherwise
 *     the sidebar itself renders the logo and duplicating it looks off.
 *   - The product name, absolutely centered regardless of left/right
 *     slots (so it stays put when the logo slot appears/disappears).
 *
 * On mobile this hosts the hamburger drawer — the collapse toggle is
 * hidden at `md-`.
 */
export function TopBar({ user }: { user: Session["user"] }) {
  const { collapsed, toggle } = useSidebarState();

  return (
    <header className="relative flex h-14 shrink-0 items-center gap-3 border-b bg-background px-4">
      <MobileDrawer user={user} />

      {/* Desktop sidebar toggle — hidden on mobile where the drawer
          handles navigation. */}
      <button
        type="button"
        onClick={toggle}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!collapsed}
        className="hidden h-9 w-9 items-center justify-center rounded-md border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:inline-flex"
      >
        {collapsed ? (
          <PanelLeft className="h-4 w-4" />
        ) : (
          <PanelLeftClose className="h-4 w-4" />
        )}
      </button>

      {/* Logo reappears here when the sidebar hides, so the brand stays
          visible in every state. Hidden on mobile — the MobileDrawer
          already owns that surface. */}
      {collapsed ? (
        <div className="hidden md:flex">
          <BrandLogo />
        </div>
      ) : null}

      <div className="ml-auto" />
    </header>
  );
}
