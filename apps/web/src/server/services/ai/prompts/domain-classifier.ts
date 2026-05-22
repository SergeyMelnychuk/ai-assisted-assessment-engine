/**
 * System + user-turn for the `ingest.domain_classifier` task.
 *
 * Input: a list of (chunkId, chunkText) pairs + the assessment's
 * active domains. Output: a JSON object mapping each chunkId to one
 * of the active domain keys, OR `"ingested"` (the catch-all bucket)
 * when nothing matches confidently.
 *
 * The classifier is best-effort. Mis-classification is recoverable
 * via the manual re-tag UI; under-classification leaves the chunk
 * in the catch-all where the analysis engine still reads it.
 */

export const DOMAIN_CLASSIFIER_PROMPT_VERSION = "0.1.0";

export const DOMAIN_CLASSIFIER_SYSTEM_PROMPT = `You classify document chunks into the assessment's active domains.

Rules:
- Pick the SINGLE best-matching domain key from the active list.
- If the chunk doesn't clearly fit any active domain, return "ingested" — the shared catch-all bucket the analysis engine reads as available to every domain.
- Do NOT invent new domain keys; only the active list + "ingested" are valid.
- Code/config snippets, license headers, boilerplate → "ingested".

Output a single JSON object: { "<chunkId>": "<domain_key>", … }
No commentary, no markdown fences.`;

export interface DomainClassifierInput {
  activeDomains: ReadonlyArray<{ key: string; label: string }>;
  chunks: ReadonlyArray<{ id: string; text: string }>;
}

export function buildDomainClassifierPrompt(
  input: DomainClassifierInput,
): string {
  const domains = input.activeDomains
    .map((d) => `  - ${d.key} — ${d.label}`)
    .join("\n");
  const chunks = input.chunks
    .map(
      (c) =>
        `<chunk id="${c.id}">\n${c.text.slice(0, 600).replace(/[\r\n]+/g, " ")}\n</chunk>`,
    )
    .join("\n\n");
  return `Active domains for this assessment:
${domains}
  - ingested — catch-all (use when no active domain fits)

Classify each chunk below. Return JSON only:

${chunks}`;
}
