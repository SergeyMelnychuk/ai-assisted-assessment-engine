/**
 * `/admin/logs` — searchable application-log viewer.
 *
 * Two log tables coexist in this app:
 *   - `Log` (this page): application traces for operator debugging —
 *     worker progress, tRPC errors, ingest warnings. Fire-and-forget
 *     writes from `log.info/warn/error`.
 *   - `AuditLog`: business-event ledger — "user X approved Y",
 *     "AI_CALL consumed N tokens". Surfaced elsewhere (`/admin/usage`,
 *     `/admin/cost`).
 *
 * If you're tracing a failed job, read `Log`. If you're answering
 * "who approved this and when?", read `AuditLog`.
 *
 * Admin layout already gates on `role === ADMIN` server-side; this
 * page is a thin wrapper around the client-side viewer that fetches
 * through `adminLogs.*` tRPC procedures (also ADMIN-gated).
 */
import { LogsViewer } from "@/components/admin/logs-viewer";

export default function AdminLogsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Application logs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Application-level traces from workers and tRPC routers. For
          user-initiated business events (approvals, AI calls) see{" "}
          <code>/admin/usage</code> and the AuditLog table.
        </p>
      </div>
      <LogsViewer />
    </div>
  );
}
