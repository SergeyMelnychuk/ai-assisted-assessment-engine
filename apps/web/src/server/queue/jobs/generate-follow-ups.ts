import { db } from "@/server/db";
import { generateFollowUpQuestions } from "@/server/services/question-engine";

/**
 * Worker-facing wrapper around the question-engine follow-up call. Keeps
 * the queue plumbing (logging, error-shape) out of the pure service
 * module. Errors bubble so BullMQ applies its retry policy.
 */
export async function generateFollowUpsJob(
  assessmentId: string,
): Promise<void> {
  const started = Date.now();
  try {
    const res = await generateFollowUpQuestions(db, assessmentId);
    console.log(
      `[generate-follow-ups] ✓ assessment=${assessmentId} created=${res.created} (${Date.now() - started}ms)`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[generate-follow-ups] ✗ assessment=${assessmentId}: ${msg}`,
    );
    throw err;
  }
}
