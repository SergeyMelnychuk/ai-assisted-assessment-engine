import type { UserRole } from "@prisma/client";
import type { DefaultSession } from "next-auth";

// Augment next-auth types so `session.user.id` and `session.user.role` are
// typed everywhere (tRPC middleware, server components, client components).
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: UserRole;
    } & DefaultSession["user"];
  }

  interface User {
    id: string;
    role: UserRole;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: UserRole;
  }
}
