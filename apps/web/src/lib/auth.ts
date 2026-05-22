import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { z } from "zod";
import { db } from "@/server/db";
import { verifyPassword } from "@/lib/password";
import type { UserRole } from "@prisma/client";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const authOptions: NextAuthOptions = {
  // Credentials provider requires JWT sessions — the Prisma adapter is
  // incompatible here and not needed: we only need an ID + role on the token.
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  providers: [
    CredentialsProvider({
      name: "Email + Password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(rawCredentials) {
        const parsed = credentialsSchema.safeParse(rawCredentials);
        if (!parsed.success) return null;

        const { email, password } = parsed.data;
        const user = await db.user.findUnique({
          where: { email: email.toLowerCase() },
        });
        if (!user) return null;

        const ok = await verifyPassword(password, user.passwordHash);
        if (!ok) return null;

        // Shape that NextAuth passes to the `jwt` callback on sign-in.
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    // Persist the user id + role on the JWT itself so tRPC middleware can
    // authorize without a DB round-trip per request.
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = user.role as UserRole;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as UserRole;
      }
      return session;
    },
  },
};
