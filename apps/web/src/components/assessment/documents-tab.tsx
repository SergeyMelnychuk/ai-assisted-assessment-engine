"use client";

import { DocumentUpload } from "./document-upload";
import { DocumentList } from "./document-list";
import { RepositoryLinkPanel } from "./repository-link-panel";

/**
 * Thin client-component shell so the server page stays async-friendly
 * without marking the whole tree "use client".
 *
 * `includeRepositoryLinks` defaults to `true` for backward compat
 * with the standalone `/documents` route which has bundled both
 * surfaces since Phase 3 Week 6. The workflow-step popup passes
 * `false` so the UPLOAD_DOCUMENTS popup is *only* about documents —
 * repositories live in their own CONNECT_REPOSITORY step.
 */
export function DocumentsTab({
  assessmentId,
  includeRepositoryLinks = true,
}: {
  assessmentId: string;
  includeRepositoryLinks?: boolean;
}) {
  return (
    <div className="space-y-6">
      <DocumentUpload assessmentId={assessmentId} />
      <DocumentList assessmentId={assessmentId} />
      {includeRepositoryLinks ? (
        <RepositoryLinkPanel assessmentId={assessmentId} />
      ) : null}
    </div>
  );
}
