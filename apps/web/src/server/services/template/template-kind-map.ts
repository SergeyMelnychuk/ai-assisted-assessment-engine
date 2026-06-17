import type { DeliverableType, TemplateKind } from "@prisma/client";

/**
 * Pure `TemplateKind → DeliverableType` mapper.
 *
 * Deliberately lives in its own dependency-free module. It used to sit
 * in `fill-and-store.ts`, but that file statically imports the heavy
 * fill stack (`filler.ts` → `exceljs` + the dynamic `yauzl-promise`,
 * which pulls the native `@node-rs/crc32` binary). The `export` tRPC
 * router only needs this 12-line switch — importing it from
 * `fill-and-store.ts` dragged the whole native-binary chain into the
 * webpack-compiled `/api/trpc` bundle and broke the build
 * (`Module parse failed: Unexpected character` on the `.node` file).
 *
 * Keep this module import-free beyond the Prisma enum types so any
 * webpack-compiled context (routers, route handlers, client-adjacent
 * server code) can use it without bundling server-only natives.
 *
 * Returns `null` for kinds that don't correspond to a deliverable —
 * `ESTIMATION` (the WBS workbook) and the legacy generic kinds
 * (`DELIVERABLE_REPORT` / `DELIVERABLE_PRESENTATION`), where the kind
 * alone doesn't pin a single deliverable type.
 */
export function templateKindToDeliverableType(
  kind: TemplateKind,
): DeliverableType | null {
  switch (kind) {
    case "EXECUTIVE_SUMMARY":
    case "ASSESSMENT_REPORT":
    case "RISK_REGISTER":
    case "TARGET_STATE":
    case "ROADMAP":
    case "TEAM_PROPOSAL":
    case "ESTIMATE":
    case "ASSUMPTIONS_GAPS":
    case "SOW_DRAFT":
    case "GREENFIELD_DISCOVERY":
      // 1:1 enum overlap between TemplateKind and DeliverableType for
      // these per-deliverable kinds.
      return kind as unknown as DeliverableType;
    default:
      return null;
  }
}
