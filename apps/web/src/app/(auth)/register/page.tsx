"use client";

import { signIn } from "next-auth/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

type FieldErrors = Partial<Record<"name" | "email" | "password", string[]>>;

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        fieldErrors?: FieldErrors;
      };

      if (!res.ok) {
        if (body.fieldErrors) setFieldErrors(body.fieldErrors);
        setError(body.error ?? "Registration failed");
        return;
      }

      // Auto-sign-in so the user lands authenticated. If this fails we still
      // drop them on /login so they can try manually.
      const signInResult = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });
      if (signInResult?.error) {
        router.push("/login");
        return;
      }
      router.push("/");
      router.refresh();
    } catch (err) {
      console.error("register failed", err);
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h2 className="text-xl font-semibold">Create account</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        You&apos;ll join as an Assessor by default. Admins can promote roles
        later.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="name" className="block text-sm font-medium">
            Full name
          </label>
          <input
            id="name"
            name="name"
            type="text"
            autoComplete="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {fieldErrors.name?.[0] ? (
            <p className="mt-1 text-xs text-destructive">
              {fieldErrors.name[0]}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="email" className="block text-sm font-medium">
            Work email
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
          {fieldErrors.email?.[0] ? (
            <p className="mt-1 text-xs text-destructive">
              {fieldErrors.email[0]}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="password" className="block text-sm font-medium">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            At least 8 characters.
          </p>
          {fieldErrors.password?.[0] ? (
            <p className="mt-1 text-xs text-destructive">
              {fieldErrors.password[0]}
            </p>
          ) : null}
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
          {submitting ? "Creating account…" : "Create account"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link
          href="/login"
          className="font-medium text-foreground hover:underline"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
