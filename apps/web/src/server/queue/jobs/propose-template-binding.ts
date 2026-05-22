import { db } from "@/server/db";
import { getObjectBuffer } from "@/server/storage/minio";
import { proposeTemplateBinding } from "@/server/services/template/binding-proposer";
import type { Prisma } from "@prisma/client";

/**
 * Worker job: run the AI binding proposer on a freshly-uploaded
 * template. Loads the file from MinIO, hands it to
 * `proposeTemplateBinding`, and writes the resulting binding JSON
 * back onto the Template row. The row stays in PROPOSED until a
 * human approves it through the UI.
 *
 * Failures are logged and surfaced as audit rows but never crash the
 * upload — the user can re-trigger the proposer from the UI, or hand-
 * author the binding in the editor.
 */
export async function proposeTemplateBindingJob(
  templateId: string,
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
  if (tpl.bindingJson) {
    // Someone (human or earlier proposer run) already authored a
    // binding. Don't clobber their work.
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

  try {
    const buffer = await getObjectBuffer(tpl.storagePath);
    const result = await proposeTemplateBinding({
      templateKind: tpl.kind,
      templateMimeType: tpl.mimeType,
      templateBuffer: buffer,
      audit: { templateId: tpl.id },
    });
    await db.template.update({
      where: { id: tpl.id },
      data: {
        bindingJson:
          result.binding as unknown as Prisma.InputJsonValue,
      },
    });
    await db.auditLog.create({
      data: {
        action: "TEMPLATE_BINDING_PROPOSED",
        entityType: "Template",
        entityId: tpl.id,
        details: {
          entryCount: result.binding.entries.length,
          warnings: result.warnings,
          tokens: result.tokens,
        },
      },
    });
    console.log(
      `[propose-template-binding] ✓ template=${templateId} entries=${result.binding.entries.length} (${Date.now() - started}ms)`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[propose-template-binding] ✗ template=${templateId}: ${msg}`,
    );
    await db.auditLog
      .create({
        data: {
          action: "TEMPLATE_BINDING_PROPOSE_FAILED",
          entityType: "Template",
          entityId: templateId,
          details: { error: msg },
        },
      })
      .catch(() => {});
    throw err;
  }
}
