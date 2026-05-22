import { redirect } from "next/navigation";

/**
 * `/admin` has no content of its own — the sidebar nav already exposes
 * every admin section (Knowledge Base, Rate Cards, Settings) so the
 * overview card grid was duplicating information. Redirect hits on the
 * bare `/admin` URL to the Settings tab, which is the most common
 * landing reason (logs / AI usage / concurrency live there).
 */
export default function AdminIndexPage(): never {
  redirect("/admin/settings");
}
