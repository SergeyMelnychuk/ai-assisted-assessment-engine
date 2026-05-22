import type { LucideIcon } from "lucide-react";
import {
  Briefcase,
  BookOpen,
  DollarSign,
  FileText,
  Home,
  LifeBuoy,
  Settings,
} from "lucide-react";
import type { UserRole } from "@prisma/client";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  // Role-gate for UI visibility. `undefined` = any authenticated role.
  requiresRole?: UserRole;
}

export interface NavSection {
  label: string;
  items: NavItem[];
  requiresRole?: UserRole;
}

// Single source of truth for the sidebar. Adding a new authenticated page?
// Add its entry here and both desktop sidebar + mobile drawer pick it up.
export const NAV_SECTIONS: NavSection[] = [
  {
    label: "Workspace",
    items: [
      { label: "Overview", href: "/overview", icon: Home },
      { label: "Engagements", href: "/engagements", icon: Briefcase },
    ],
  },
  {
    label: "Admin",
    requiresRole: "ADMIN",
    items: [
      // No Overview entry — /admin itself is now a redirect to Settings,
      // and the previous card grid duplicated what the sidebar already
      // exposes. Each admin surface is a direct link below.
      {
        label: "Knowledge Base",
        href: "/admin/knowledge-base",
        icon: BookOpen,
      },
      { label: "Rate Cards", href: "/admin/rate-cards", icon: DollarSign },
      { label: "Templates", href: "/admin/templates", icon: FileText },
      // Logs + AI usage + AI router live under the tabbed /admin/settings
      // surface so operators have one stop for runtime tuning + observability.
      { label: "Settings", href: "/admin/settings", icon: Settings },
      // Operator handbook — index of per-surface guides, each rendered
      // from markdown in docs/guides so ops updates ship via PR rather
      // than code changes.
      { label: "Guides", href: "/admin/guides", icon: LifeBuoy },
    ],
  },
];

// Role precedence. Used for `requiresRole` gating. ADMIN implicitly sees
// everything; VIEWER is the most restricted.
const ROLE_PRECEDENCE: Record<UserRole, number> = {
  ADMIN: 3,
  REVIEWER: 2,
  ASSESSOR: 1,
  VIEWER: 0,
};

export function hasRole(actual: UserRole, required: UserRole | undefined) {
  if (!required) return true;
  return ROLE_PRECEDENCE[actual] >= ROLE_PRECEDENCE[required];
}
