"use client";

import { signIn } from "next-auth/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // If middleware redirected the user to /login, NextAuth preserves where
  // they were headed in `callbackUrl`. Default to /engagements once we have
  // that route (Task 5). For now fall back to /.
  const callbackUrl = searchParams.get("callbackUrl") ?? "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await signIn("credentials", {
        email,
        password,
        redirect: false,
        callbackUrl,
      });
      if (!result) {
        setError("Sign-in did not return a response. Please try again.");
        return;
      }
      if (result.error) {
        // NextAuth returns "CredentialsSignin" for any authorize() that
        // resolves null — we don't distinguish unknown-email from wrong-
        // password, to avoid account enumeration.
        setError("Invalid email or password");
        return;
      }
      router.push(result.url ?? callbackUrl);
      router.refresh();
    } catch (err) {
      console.error("login failed", err);
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h2 className="text-xl font-semibold">Sign in</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Welcome back. Enter your credentials to continue.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="email" className="block text-sm font-medium">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div>
          <label htmlFor="password" className="block text-sm font-medium">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Don&apos;t have an account?{" "}
        <Link
          href="/register"
          className="font-medium text-foreground hover:underline"
        >
          Create one
        </Link>
      </p>
    </div>
  );
}
