/**
 * One-off (idempotent) cleanup for assessments stuck in the `ANALYSIS`
 * stage after a successful run.
 *
 * Bug symptom: `apps/web/src/server/queue/jobs/run-analysis.ts` used to
 * flip `assessment.status` into `ANALYSIS` at the start of the job but
 * never out of it on success. Three known orphans were observed going
 * back to 2026-04-16:
 *
 *   - cmo1rue8a0007v8is0tkuai4s
 *   - cmo347r9u0001v8w6l5dgjr53
 *   - cmo4w3nmv000bv8dud4k23qmr
 *
 * This script generalises the fix: it finds every assessment whose
 * `status = ANALYSIS` and whose most-recent `RUN_ANALYSIS` (success)
 * row is newer than the most-recent `ENQUEUE_ANALYSIS` row — i.e.
 * the run completed but the worker never flipped stage — and advances
 * them to `DRAFTING` (the post-analysis stage per the AssessmentStage
 * enum). Idempotent: running it twice is a no-op the second time.
 *
 * Run with:
 *   node --env-file=apps/web/.env --import tsx \
 *     apps/web/scripts/backfill-stuck-analysis-status.ts
 */
import { PrismaClient } from "@prisma/client";

const POST_ANALYSIS_STAGE = "DRAFTING" as const;

async function main(): Promise<void> {
  const db = new PrismaClient();
  try {
    const stuck = await db.assessment.findMany({
      where: { status: "ANALYSIS" },
      select: { id: true, status: true, updatedAt: true },
    });

    console.log(
      `[backfill] found ${stuck.length} assessment(s) currently in ANALYSIS`,
    );

    const flipped: Array<{
      id: string;
      runAt: Date;
      enqueueAt: Date | null;
    }> = [];
    const skipped: Array<{ id: string; reason: string }> = [];

    for (const a of stuck) {
      const lastEnqueue = await db.auditLog.findFirst({
        where: {
          entityType: "Assessment",
          entityId: a.id,
          action: "ENQUEUE_ANALYSIS",
        },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      // Any terminal RUN_ANALYSIS* row means the worker has
      // finished with this assessment — success, hard failure, or
      // cancel. All three paths should have cleared the ANALYSIS
      // stage; the original bug left all three stuck. We treat them
      // uniformly here.
      const lastRun = await db.auditLog.findFirst({
        where: {
          entityType: "Assessment",
          entityId: a.id,
          action: {
            in: [
              "RUN_ANALYSIS",
              "RUN_ANALYSIS_FAILED",
              "RUN_ANALYSIS_CANCELLED",
            ],
          },
        },
        orderBy: { createdAt: "desc" },
        select: { action: true, createdAt: true },
      });
      if (!lastRun) {
        // Separate class: no terminal row at all. Either the worker
        // crashed mid-run or the job was never dequeued (Redis
        // restart, BullMQ config drift). If the most-recent enqueue
        // is more than `STALE_ENQUEUE_MS` old we treat it as a dead
        // run and flip anyway — otherwise we might fight a real
        // in-flight job. One of the 2026-04-16 orphans
        // (cmo1rue8a0007v8is0tkuai4s) falls into this bucket.
        const STALE_ENQUEUE_MS = 60 * 60 * 1000; // 1 hour
        const ageMs = lastEnqueue
          ? Date.now() - lastEnqueue.createdAt.getTime()
          : Infinity;
        if (!lastEnqueue || ageMs > STALE_ENQUEUE_MS) {
          const updated = await db.assessment
            .update({
              where: { id: a.id, status: "ANALYSIS" },
              data: { status: POST_ANALYSIS_STAGE },
            })
            .catch(() => null);
          if (!updated) {
            skipped.push({
              id: a.id,
              reason: "status drifted before update (stale-enqueue path)",
            });
            continue;
          }
          console.log(
            `  flipped ${a.id} (stale enqueue, no terminal row; enqueueAgeMs=${ageMs})`,
          );
          flipped.push({
            id: a.id,
            // Use the enqueue time as the "runAt" marker for logging —
            // there's no terminal row to quote.
            runAt: lastEnqueue?.createdAt ?? new Date(0),
            enqueueAt: lastEnqueue?.createdAt ?? null,
          });
          continue;
        }
        skipped.push({
          id: a.id,
          reason: `no terminal row, enqueue only ${Math.round(ageMs / 1000)}s old (likely in flight)`,
        });
        continue;
      }
      // Only flip if the success row is at least as new as the enqueue
      // — otherwise a fresh run is in flight and we'd be fighting it.
      if (lastEnqueue && lastEnqueue.createdAt > lastRun.createdAt) {
        skipped.push({
          id: a.id,
          reason: "ENQUEUE newer than RUN_ANALYSIS (in-flight run)",
        });
        continue;
      }
      // Atomic guard: only flip if still ANALYSIS — a concurrent user
      // edit between our read and write should win.
      const updated = await db.assessment
        .update({
          where: { id: a.id, status: "ANALYSIS" },
          data: { status: POST_ANALYSIS_STAGE },
        })
        .catch(() => null);
      if (!updated) {
        skipped.push({ id: a.id, reason: "status drifted before update" });
        continue;
      }
      flipped.push({
        id: a.id,
        runAt: lastRun.createdAt,
        enqueueAt: lastEnqueue?.createdAt ?? null,
      });
      console.log(
        `  flipped ${a.id} (terminal=${lastRun.action}@${lastRun.createdAt.toISOString()})`,
      );
    }

    console.log(`[backfill] flipped ${flipped.length} assessment(s):`);
    for (const f of flipped) {
      console.log(
        `  - ${f.id} (last RUN_ANALYSIS=${f.runAt.toISOString()}${f.enqueueAt ? `, last ENQUEUE=${f.enqueueAt.toISOString()}` : ""})`,
      );
    }
    if (skipped.length > 0) {
      console.log(`[backfill] skipped ${skipped.length} assessment(s):`);
      for (const s of skipped) {
        console.log(`  - ${s.id}: ${s.reason}`);
      }
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error("[backfill] failed:", err);
  process.exit(1);
});
