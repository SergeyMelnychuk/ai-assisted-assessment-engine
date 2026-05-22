"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { UserRole } from "@prisma/client";
import { cn } from "@/lib/utils";
import { NAV_SECTIONS, hasRole } from "./nav-config";

// Renders the link list used by both the desktop sidebar and the mobile
// drawer. Client component only because we need `usePathname()` for the
// "active" highlight — the links themselves are server-rendered.
export function SidebarNav({
  role,
  onNavigate,
}: {
  role: UserRole;
  // Fires after a link click. Mobile drawer uses this to auto-close itself.
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-6">
      {NAV_SECTIONS.filter((section) => hasRole(role, section.requiresRole)).map(
        (section) => (
          <div key={section.label}>
            <p className="px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {section.label}
            </p>
            <ul className="mt-2 flex flex-col gap-1">
              {section.items
                .filter((item) => hasRole(role, item.requiresRole))
                .map((item) => {
                  const Icon = item.icon;
                  // Active if URL matches exactly or starts with the item's
                  // href + "/" (so `/engagements/42` activates "Engagements").
                  const isActive =
                    pathname === item.href ||
                    pathname.startsWith(`${item.href}/`);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={onNavigate}
                        className={cn(
                          "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                          isActive
                            ? "bg-primary text-primary-foreground"
                            : "text-foreground hover:bg-muted",
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0" aria-hidden />
                        <span>{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
            </ul>
          </div>
        ),
      )}
    </nav>
  );
}
