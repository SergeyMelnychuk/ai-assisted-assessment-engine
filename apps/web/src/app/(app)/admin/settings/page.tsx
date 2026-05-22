/**
 * `/admin/settings` — consolidated admin surface.
 *
 * Merges the former standalone `/admin/logs` and `/admin/usage` pages
 * into a single tabbed view so operators have one stop for runtime
 * tuning + observability. The admin layout already gates on
 * `role === ADMIN` server-side, so this page is a thin render shell.
 *
 * Tabs (client-side, URL-preserving):
 *   - Settings (default) — runtime-editable knobs (concurrency, pacing)
 *   - Logs                — mirror of the old /admin/logs viewer
 *   - AI Usage            — mirror of the old /admin/usage dashboard
 */
import { SettingsPageTabs } from "@/components/admin/settings/tabs";

export default function AdminSettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Admin settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Runtime tuning, application logs, and AI usage — all in one
          place. Changes to settings take effect on the next assessment
          run without a restart.
        </p>
      </div>
      <SettingsPageTabs />
    </div>
  );
}
