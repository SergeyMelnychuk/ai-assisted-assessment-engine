import { callAi, parseJsonResponse } from "../ai/router";
import {
  DOMAIN_CLASSIFIER_SYSTEM_PROMPT,
  buildDomainClassifierPrompt,
} from "../ai/prompts/domain-classifier";
import { domainLabel } from "@/lib/domain-labels";

/**
 * Per-chunk domain classifier (Option B of the per-domain tagging
 * work).
 *
 * Takes a list of chunks + the assessment's active domains and asks
 * the AI router to assign each chunk a domain key. The result is a
 * partial map; chunks the model couldn't classify confidently get
 * `"ingested"` (the catch-all bucket the analysis engine still reads
 * as available to every domain).
 *
 * Best-effort: a router failure or a malformed model response leaves
 * every chunk in the catch-all and emits a warning. The ingest
 * worker's caller catches and continues — classification never blocks
 * a successful ingest.
 */

export interface ClassifyChunksInput {
  activeDomains: readonly string[];
  chunks: ReadonlyArray<{ id: string; text: string }>;
  /** Forwarded to the AI router so the cost-rollup ties classification
   *  spend to the originating Document. */
  audit?: { documentId: string };
}

export interface ClassifyChunksResult {
  /** Map keyed by chunk id; missing keys → caller treats as "ingested". */
  domainByChunkId: Map<string, string>;
  warnings: string[];
  tokens: { input: number; output: number };
}

/**
 * Anthropic's prompt-cache window is finite; batching also keeps a
 * single classification round trip well under the model's context
 * cap. 32 chunks × ~600 chars + the active-domains list lands at
 * ~25k input tokens — comfortable for any modern Sonnet/Haiku tier.
 */
const BATCH_SIZE = 32;

export async function classifyChunkDomains(
  input: ClassifyChunksInput,
): Promise<ClassifyChunksResult> {
  if (input.activeDomains.length === 0 || input.chunks.length === 0) {
    return {
      domainByChunkId: new Map(),
      warnings: [],
      tokens: { input: 0, output: 0 },
    };
  }

  const allowed = new Set<string>([...input.activeDomains, "ingested"]);
  const labelled = input.activeDomains.map((key) => ({
    key,
    label: domainLabel(key),
  }));

  const out = new Map<string, string>();
  const warnings: string[] = [];
  const totalTokens = { input: 0, output: 0 };

  // Process in deterministic batches so a partial failure in batch N
  // still gets us domain tags for batches 0..N-1.
  for (let i = 0; i < input.chunks.length; i += BATCH_SIZE) {
    const batch = input.chunks.slice(i, i + BATCH_SIZE);
    try {
      const res = await callAi<unknown>({
        task: "ingest.domain_classifier",
        system: DOMAIN_CLASSIFIER_SYSTEM_PROMPT,
        userContent: buildDomainClassifierPrompt({
          activeDomains: labelled,
          chunks: batch,
        }),
        assistantPrefill: "{",
        parseResult: (raw) => parseJsonResponse<unknown>(raw),
        maxTokens: 1_500,
        audit: input.audit
          ? {
              callType: "ingest",
              entityType: "Document",
              entityId: input.audit.documentId,
            }
          : undefined,
      });
      totalTokens.input += res.tokensUsed?.input ?? 0;
      totalTokens.output += res.tokensUsed?.output ?? 0;
      const obj = res.result;
      if (!obj || typeof obj !== "object") {
        warnings.push(
          `Classifier returned non-object for batch ${i / BATCH_SIZE}.`,
        );
        continue;
      }
      for (const [chunkId, domain] of Object.entries(
        obj as Record<string, unknown>,
      )) {
        if (typeof domain !== "string") continue;
        if (!allowed.has(domain)) {
          warnings.push(
            `Classifier returned unknown domain "${domain}" for chunk ${chunkId} — dropping.`,
          );
          continue;
        }
        out.set(chunkId, domain);
      }
    } catch (err) {
      warnings.push(
        `Classifier batch ${i / BATCH_SIZE} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return { domainByChunkId: out, warnings, tokens: totalTokens };
}
