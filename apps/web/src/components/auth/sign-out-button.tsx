"use client";

import { signOut } from "next-auth/react";
import { useState } from "react";

export function SignOutButton({
  className,
  children = "Sign out",
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  const [submitting, setSubmitting] = useState(false);

  return (
    <button
      type="button"
      disabled={submitting}
      onClick={async () => {
        setSubmitting(true);
        // `callbackUrl: "/"` sends the user back to the public landing page,
        // which re-renders unauthenticated once the session cookie is cleared.
        await signOut({ callbackUrl: "/" });
      }}
      className={
        className ??
        "rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
      }
    >
      {submitting ? "Signing out…" : children}
    </button>
  );
}
