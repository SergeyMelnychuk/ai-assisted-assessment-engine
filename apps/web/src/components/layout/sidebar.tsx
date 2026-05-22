"use client";

import type { Session } from "next-auth";
import { SidebarNav } from "./sidebar-nav";
import { UserBlock } from "./user-block";
import { BrandLogo } from "./brand-logo";
import { useSidebarState } from "./sidebar-state";

/**
 * Desktop sidebar — fixed 256px when expanded, fully hidden when
 * collapsed. Mobile uses the drawer inside the TopBar instead.
 *
 * When collapsed we animate width → 0 and `overflow-hidden` so the nav
 * items don't flash outside the shrinking box mid-transition. The
 * BrandLogo hops to the TopBar (see `top-bar.tsx`) so it stays visible
 * in either state.
 */
export function Sidebar({ user }: { user: Session["user"] }) {
  const { collapsed } = useSidebarState();

  return (
    <aside
      className={`hidden shrink-0 overflow-hidden border-r bg-background transition-[width] duration-200 ease-out md:flex md:flex-col ${
        collapsed ? "w-0 border-r-0" : "w-64"
      }`}
      aria-hidden={collapsed}
    >
      {/* Inner wrapper keeps fixed width so children don't reflow while
          the outer `width` transitions — otherwise the nav labels would
          wrap during the shrink and look glitchy. */}
      <div className="flex w-64 flex-col h-full">
        <div className="flex h-14 items-center border-b px-4">
          <BrandLogo />
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-4">
          <SidebarNav role={user.role} />
        </div>

        <div className="border-t p-3">
          <UserBlock user={user} />
        </div>
      </div>
    </aside>
  );
}
