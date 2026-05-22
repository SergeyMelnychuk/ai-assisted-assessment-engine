import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export default async function HomePage() {
  const session = await getServerSession(authOptions);

  // Authenticated users land on the Overview page (the product's
  // orientation + guideline surface). `/` is reserved for the unauth
  // marketing / sign-in CTA. Server-side redirect avoids the flicker
  // of rendering the unauth CTA for a signed-in user.
  if (session?.user) {
    redirect("/overview");
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <div className="mb-10">
        <p className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Assessment Co-Pilot
        </p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight">
          AI-Powered Discovery, Audit &amp; Solution Shaping
        </h1>
        <p className="mt-4 text-lg text-muted-foreground">
          A consulting co-pilot that standardizes, accelerates, and partially
          automates early-stage engagements. Human-in-the-loop by design, with
          full evidence traceability.
        </p>
      </div>

      <section className="rounded-lg border bg-card p-6">
        <h2 className="text-lg font-semibold">Get started</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Sign in with your account, or create a new one to begin an
          assessment.
        </p>

        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/login"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            Sign in
          </Link>
          <Link
            href="/register"
            className="rounded-md border border-input bg-background px-4 py-2 text-sm font-medium transition hover:bg-muted"
          >
            Create account
          </Link>
        </div>
      </section>
    </main>
  );
}
