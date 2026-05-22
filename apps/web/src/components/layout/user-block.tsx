import type { Session } from "next-auth";
import { SignOutButton } from "@/components/auth/sign-out-button";

// Shown at the bottom of the sidebar (and at the top of the mobile drawer).
// Pure server component — no client JS except the SignOutButton itself.
export function UserBlock({ user }: { user: Session["user"] }) {
  const initials = (user.name ?? user.email ?? "?")
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="rounded-md border bg-muted/40 p-3">
      <div className="flex items-center gap-3">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
          aria-hidden
        >
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {user.name ?? user.email}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {user.role}
          </p>
        </div>
      </div>
      <SignOutButton className="mt-3 w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60" />
    </div>
  );
}
