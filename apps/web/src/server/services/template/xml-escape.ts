/**
 * Escape the three XML special characters that matter for our OOXML
 * substitutions: `&`, `<`, `>`. Quotes don't need escaping in text-
 * node content (only in attribute values, which we never substitute
 * into).
 *
 * Extracted from `filler.ts` so the markdown→OOXML renderer can
 * reuse the same escaping rules.
 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
