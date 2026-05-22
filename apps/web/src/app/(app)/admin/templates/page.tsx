import { TemplatesWorkspace } from "@/components/templates/templates-workspace";

/**
 * Admin templates page — manage workspace-default templates (rows
 * with `Template.engagementId = null`) from one place. The admin
 * layout already gates on `role === ADMIN` server-side, so any
 * non-admin reaching this URL is redirected before render.
 *
 * Workspace defaults are visible to every authenticated user (they
 * show up in every engagement's template picker) but only admins can
 * upload, approve, or otherwise mutate them.
 */
export default function AdminTemplatesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Templates</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Workspace-default templates. Uploads here are available in
          every engagement&apos;s template picker. Engagement owners can
          still upload engagement-scoped templates from inside their
          engagement.
        </p>
      </div>
      <TemplatesWorkspace engagementId={null} />
    </div>
  );
}
