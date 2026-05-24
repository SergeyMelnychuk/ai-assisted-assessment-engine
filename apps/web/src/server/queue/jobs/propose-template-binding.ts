import { db } from "@/server/db";
import { getObjectBuffer } from "@/server/storage/minio";
import { proposeTemplateBinding } from "@/server/services/template/binding-proposer";
import {
  bindingDocumentSchema,
  type BindingDocument,
} from "@/server/services/template/binding";
import type { Prisma } from "@prisma/client";

/**
 * Worker job: run the AI binding proposer on a template. Loads the
 * file from MinIO, hands it to `proposeTemplateBinding`, and writes
 * the resulting binding JSON back onto the Template row.
 *
 * Two modes:
 *   - **Initial** (no `isRepropose` flag) — runs on first upload.
 *     Skips if the row already has a binding (so manual edits or an
 *     earlier proposer run don't get clobbered).
 *   - **Re-propose** (`isRepropose: true`, set by the
 *     `template.reproposeBinding` mutation) — bypasses the skip guard
 *     and pipes the reviewer's `feedback` + optional `priorBinding`
 *     into the proposer. With `priorBinding` set, the AI refines the
 *     existing binding; without it, the AI starts fresh.
 *
 * Failures are logged + surfaced as audit rows but never crash the
 * upload — the user can re-trigger the proposer from the UI, or
 * hand-author the binding in the editor.
 */
export async function proposeTemplateBindingJob(
  templateId: string,
  opts: {
    isRepropose?: boolean;
    feedback?: string;
    priorBinding?: unknown;
  } = {},
): Promise<void> {
  const started = Date.now();
  const tpl = await db.template.findUnique({
    where: { id: templateId },
    select: {
      id: true,
      kind: true,
      mimeType: true,
      storagePath: true,
      bindingJson: true,
    },
  });
  if (!tpl) {
    console.warn(
      `[propose-template-binding] template ${templateId} not found — skipping`,
    );
    return;
  }
  if (tpl.bindingJson && !opts.isRepropose) {
    // Initial-proposal path: someone (human or earlier proposer run)
    // already authored a binding. Don't clobber their work. The
    // re-propose path intentionally bypasses this guard.
    console.log(
      `[propose-template-binding] template ${templateId} already has binding — skipping`,
    );
    return;
  }
  if (tpl.storagePath === "pending") {
    console.warn(
      `[propose-template-binding] template ${templateId} has no storage key yet — skipping`,
    );
    return;
  }

  const mode = opts.isRepropose
    ? opts.priorBinding
      ? "refine"
      : "fresh"
    : "initial";

  // Validate the prior binding the mutation handed us BEFORE feeding it
  // to the AI. A corrupted prior binding would just become noise in the
  // prompt — better to drop it and degrade gracefully to a fresh
  // proposal (with the reviewer's feedback still attached).
  let parsedPriorBinding: BindingDocument | undefined;
  if (opts.priorBinding) {
    const parsed = bindingDocumentSchema.safeParse(opts.priorBinding);
    if (parsed.success) {
      parsedPriorBinding = parsed.data;
    } else {
      console.warn(
        `[propose-template-binding] template=${templateId} prior binding failed schema validation, falling back to fresh proposal`,
      );
    }
  }

  try {
    const buffer = await getObjectBuffer(tpl.storagePath);
    const result = await proposeTemplateBinding({
      templateKind: tpl.kind,
      templateMimeType: tpl.mimeType,
      templateBuffer: buffer,
      audit: { templateId: tpl.id },
      feedback: opts.feedback,
      priorBinding: parsedPriorBinding,
    });

    // Diff vs. prior — cheap counts so the reviewer can see at a
    // glance how much the AI changed without diffing the JSON
    // manually. Only meaningful for re-propose; for initial proposal
    // we report 0 added / 0 removed since there's nothing to compare.
    const diff =
      parsedPriorBinding != null
        ? diffEntryCounts(parsedPriorBinding, result.binding)
        : { added: 0, removed: 0, changed: 0 };

    await db.template.update({
      where: { id: tpl.id },
      data: {
        bindingJson:
          result.binding as unknown as Prisma.InputJsonValue,
      },
    });
    await db.auditLog.create({
      data: {
        action: opts.isRepropose
          ? "TEMPLATE_BINDING_REPROPOSED"
          : "TEMPLATE_BINDING_PROPOSED",
        entityType: "Template",
        entityId: tpl.id,
        details: {
          mode,
          entryCount: result.binding.entries.length,
          warnings: result.warnings,
          tokens: result.tokens,
          feedback: opts.feedback ?? null,
          diff,
        },
      },
    });
    console.log(
      `[propose-template-binding] ✓ template=${templateId} mode=${mode} entries=${result.binding.entries.length} (${Date.now() - started}ms)`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[propose-template-binding] ✗ template=${templateId} mode=${mode}: ${msg}`,
    );
    await db.auditLog
      .create({
        data: {
          action: opts.isRepropose
            ? "TEMPLATE_BINDING_REPROPOSE_FAILED"
            : "TEMPLATE_BINDING_PROPOSE_FAILED",
          entityType: "Template",
          entityId: templateId,
          details: { mode, error: msg, feedback: opts.feedback ?? null },
        },
      })
      .catch(() => {});
    throw err;
  }
}

/**
 * Cheap entry-count diff between two bindings. Doesn't compare entry
 * SHAPES — that's a full JSON-diff problem and the reviewer can read
 * the bindings directly if they want surgical comparison. Counts are
 * enough to answer "did the AI actually change anything substantive?"
 * Entry identity is `field + target.token | target.cell | target.name`.
 */
function diffEntryCounts(
  prior: BindingDocument,
  next: BindingDocument,
): { added: number; removed: number; changed: number } {
  function key(e: BindingDocument["entries"][number]): string {
    const t = e.target;
    let targetKey = "";
    if (t.kind === "docx.placeholder") targetKey = t.token;
    else if (t.kind === "docx.bookmark") targetKey = t.name;
    else if (t.kind === "xlsx.cell") targetKey = `${t.sheet}!${t.cell}`;
    else if (t.kind === "xlsx.namedRange") targetKey = t.name;
    else if (t.kind === "xlsx.tableRow")
      targetKey = `${t.sheet}!${t.startCell}/${t.column}`;
    return `${e.field}|${t.kind}|${targetKey}`;
  }
  const priorMap = new Map(prior.entries.map((e) => [key(e), e]));
  const nextMap = new Map(next.entries.map((e) => [key(e), e]));
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const [k, n] of nextMap) {
    const p = priorMap.get(k);
    if (!p) {
      added += 1;
    } else if (JSON.stringify(p) !== JSON.stringify(n)) {
      // Same identity but different format / groupKey / note.
      changed += 1;
    }
  }
  for (const [k] of priorMap) {
    if (!nextMap.has(k)) removed += 1;
  }
  return { added, removed, changed };
}
