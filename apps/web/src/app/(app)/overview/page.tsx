import Link from "next/link";
import { getServerSession } from "next-auth";
import {
  BookOpen,
  Briefcase,
  ClipboardList,
  DollarSign,
  FileOutput,
  HelpCircle,
  ListChecks,
  PlusCircle,
  Settings as SettingsIcon,
  Sparkles,
  Target,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { authOptions } from "@/lib/auth";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Default landing page for every authenticated user.
 *
 * Purpose:
 *   1. Orient new users — what the product is, why it exists, and how
 *      a typical engagement flows end-to-end.
 *   2. Send them somewhere useful — the only actions that make sense
 *      from a cold start are "open an existing engagement" or "create
 *      a new one". Every other step (Documents, Questions, Findings…)
 *      lives inside an engagement, so we render those as a flow
 *      diagram rather than fake navigation that'd just redirect back
 *      to the engagements list.
 *
 * Admin tiles (Knowledge Base / Rate Cards / Settings) stay on the
 * dedicated `/admin` surface and only appear here for ADMIN users.
 */
export default async function OverviewPage() {
  const session = await getServerSession(authOptions);
  const isAdmin = session?.user.role === "ADMIN";

  return (
    <div className="space-y-10">
      <section className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Assessment Co-Pilot
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          AI-powered discovery, audit &amp; solution shaping
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          A consulting co-pilot that standardizes, accelerates, and partially
          automates early-stage engagements. Human-in-the-loop by design —
          the assistant drafts, you decide. Every finding, score, and line
          in the final deliverable is traceable to the source evidence that
          produced it.
        </p>
      </section>

      <section className="rounded-lg border bg-muted/10 p-5">
        <div className="flex items-start gap-3">
          <Sparkles className="mt-0.5 h-5 w-5 text-muted-foreground" />
          <div className="space-y-2">
            <h2 className="text-sm font-semibold">What it does for you</h2>
            <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
              <li>
                <span className="text-foreground">Standardizes</span> the
                shape of every discovery — the same domains, the same
                maturity scale, the same deliverable skeleton across
                clients, so you can compare like with like.
              </li>
              <li>
                <span className="text-foreground">Accelerates</span> the
                drudge work — document ingestion, baseline questionnaire
                generation, finding extraction, draft recommendations —
                so consultants spend their hours on judgement, not
                transcription.
              </li>
              <li>
                <span className="text-foreground">Grounds every claim</span>{" "}
                in evidence — findings, risks, and scores carry links to
                the source excerpt, so reviewers can audit the reasoning
                instead of trusting the model.
              </li>
              <li>
                <span className="text-foreground">
                  Keeps humans in the loop
                </span>{" "}
                — nothing ships without review. Approve, edit, reject,
                or regenerate at every stage.
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            How a typical engagement flows
          </h2>
          <p className="max-w-3xl text-xs text-muted-foreground">
            Each stage hands off to the next — answers shape findings,
            findings feed scoring, scores inform recommendations, and the
            whole thing rolls up into an exportable deliverable. You can
            loop back at any point; the evidence trail stays intact.
          </p>
        </div>
        <FlowDiagram />
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Jump in
          </h2>
          <p className="text-xs text-muted-foreground">
            Pick up where you left off, or start a new engagement.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <GuidelineTile
            icon={Briefcase}
            title="Engagements"
            href="/engagements"
            description="All the engagements you can see, newest first. Open one to continue the work — documents, questions, findings, scoring, estimate, and deliverables all live under a single engagement."
          />
          <GuidelineTile
            icon={PlusCircle}
            title="New engagement"
            href="/engagements/new"
            description="Start a fresh piece of work. Capture the client and industry, then configure the first assessment's scope, mode, and project context. You can always add more assessments later."
          />
        </div>
      </section>

      {isAdmin ? (
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Admin
            </h2>
            <p className="text-xs text-muted-foreground">
              Tenant-wide configuration. Only visible to admins.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            <GuidelineTile
              icon={BookOpen}
              title="Knowledge Base"
              href="/admin/knowledge-base"
              description="Question templates, risk patterns, recommendations, role catalog, and reference architectures."
            />
            <GuidelineTile
              icon={DollarSign}
              title="Rate Cards"
              href="/admin/rate-cards"
              description="Hourly and daily rates per role and currency. Feeds every engagement's pricing block."
            />
            <GuidelineTile
              icon={SettingsIcon}
              title="Settings"
              href="/admin/settings"
              description="Runtime tuning and observability — application logs, AI usage and spend, concurrency."
            />
          </div>
        </section>
      ) : null}
    </div>
  );
}

/**
 * Flow diagram for the engagement lifecycle. Rendered as a grid of
 * gradient-tinted stage cards connected by arrows so the "A → B → C"
 * reading is obvious on any viewport width:
 *   - 1 col on phones (vertical stack with ↓ separators)
 *   - 4 cols at md (two rows of four, horizontal → arrows between cells)
 *
 * Colors step through the Tailwind hue palette to reinforce the linear
 * progression; tone intensity stays at /10-/20 so the cards don't
 * fight the rest of the page chrome.
 */
function FlowDiagram() {
  const stages: {
    icon: LucideIcon;
    title: string;
    blurb: string;
    gradient: string;
    iconColor: string;
  }[] = [
    {
      icon: Briefcase,
      title: "Engagement",
      blurb: "Client + context. One per piece of work.",
      gradient: "from-indigo-500/15 to-indigo-500/5 border-indigo-500/30",
      iconColor: "text-indigo-500",
    },
    {
      icon: ClipboardList,
      title: "Documents",
      blurb: "Upload RFPs, decks, prior audits. AI grounds on these.",
      gradient: "from-sky-500/15 to-sky-500/5 border-sky-500/30",
      iconColor: "text-sky-500",
    },
    {
      icon: HelpCircle,
      title: "Questions",
      blurb: "Baseline + AI follow-ups per domain. Answer collaboratively.",
      gradient: "from-cyan-500/15 to-cyan-500/5 border-cyan-500/30",
      iconColor: "text-cyan-500",
    },
    {
      icon: ListChecks,
      title: "Findings",
      blurb: "Findings, risks, recommendations distilled from evidence.",
      gradient: "from-teal-500/15 to-teal-500/5 border-teal-500/30",
      iconColor: "text-teal-500",
    },
    {
      icon: Target,
      title: "Scoring",
      blurb: "Per-domain maturity scores with confidence and rationale.",
      gradient: "from-emerald-500/15 to-emerald-500/5 border-emerald-500/30",
      iconColor: "text-emerald-500",
    },
    {
      icon: Users,
      title: "Team & estimate",
      blurb: "Assemble the team, apply rate cards, price the work.",
      gradient: "from-amber-500/15 to-amber-500/5 border-amber-500/30",
      iconColor: "text-amber-500",
    },
    {
      icon: FileOutput,
      title: "Deliverable",
      blurb: "Assembled report ready for review.",
      gradient: "from-orange-500/15 to-orange-500/5 border-orange-500/30",
      iconColor: "text-orange-500",
    },
    {
      icon: Sparkles,
      title: "Export",
      blurb: "Ship it — shareable document for the client.",
      gradient: "from-rose-500/15 to-rose-500/5 border-rose-500/30",
      iconColor: "text-rose-500",
    },
  ];

  return (
    <ol className="grid gap-3 md:grid-cols-4">
      {stages.map((s, idx) => {
        const Icon = s.icon;
        // Arrow glyph placement:
        //   - md+: "→" between consecutive cards *within* a row only.
        //   - mobile (stacked): "↓" below each card except the last.
        //
        // We deliberately don't draw a row-wrap glyph (4 → 5) on
        // desktop. In a 4-col grid every natural placement lands on
        // the wrong neighbour: "↓" under card 4 sits directly above
        // card 8 (reads as 4 → 8); "↵" above card 5 sits directly
        // below card 1 (reads as 1 → 5). The correct rendering would
        // be an SVG curve from card 4's right edge, around, to card
        // 5's left edge — more code than this decoration earns.
        // The numbered tiles (1–8) already make the sequence
        // unambiguous, so the wrap is implicit.
        const isLastInRowMd = idx === 3;
        const isLastOverall = idx === stages.length - 1;
        return (
          <li
            key={s.title}
            className={`relative flex flex-col gap-2 rounded-lg border bg-gradient-to-br p-4 ${s.gradient}`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-full border bg-background text-xs font-semibold ${s.iconColor}`}
              >
                {idx + 1}
              </span>
              <Icon className={`h-4 w-4 ${s.iconColor}`} aria-hidden />
              <span className="text-sm font-semibold">{s.title}</span>
            </div>
            <p className="text-xs text-muted-foreground">{s.blurb}</p>

            {/* Desktop: within-row → arrows only. No row-wrap glyph
                (see comment above the return — every placement in a
                4-col grid reads as the wrong connection). */}
            {!isLastOverall && !isLastInRowMd ? (
              <span
                aria-hidden
                className="pointer-events-none absolute -right-2 top-1/2 hidden -translate-y-1/2 text-lg text-muted-foreground md:block"
              >
                →
              </span>
            ) : null}

            {/* Mobile arrows (vertical stack) */}
            {!isLastOverall ? (
              <span
                aria-hidden
                className="pointer-events-none absolute -bottom-3 left-1/2 -translate-x-1/2 text-lg text-muted-foreground md:hidden"
              >
                ↓
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Single tile on the Overview grid. Wraps a `Card` in a `Link` so the
 * entire card is one click target (keyboard-accessible via the link).
 */
function GuidelineTile({
  icon: Icon,
  title,
  description,
  href,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  href: string;
}) {
  return (
    <Link href={href} className="block">
      <Card className="h-full transition-colors hover:bg-muted/30">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
            <CardTitle className="text-base">{title}</CardTitle>
          </div>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
      </Card>
    </Link>
  );
}
