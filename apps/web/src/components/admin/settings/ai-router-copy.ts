/**
 * Human-readable copy for the AI Router admin tab.
 *
 * The router's task keys (`analysis.synthesis` etc.) and raw provider
 * tuples (`anthropic:claude-sonnet-4-7`) are precise but opaque to
 * operators who aren't already inside the routing code. This module
 * turns both into plain-English labels + descriptions so the admin UI
 * doesn't read like an engineer's internal log.
 *
 * Keeping these strings in a sibling file (not inside the tab
 * component) so they're easy to review in isolation and can be reused
 * by the user guide page without pulling in React.
 */

import type { AiTask, Provider } from "@/server/services/ai/model-registry";

export interface TaskCopy {
  /** Short display title — replaces the raw task key in the UI. */
  title: string;
  /** One-paragraph plain-English explanation of what the task does. */
  description: string;
  /**
   * Short hint about why this particular task's binding matters —
   * cost, latency, quality trade-offs. Shown under the fallback list.
   */
  operationalNote: string;
}

export const TASK_COPY: Record<AiTask, TaskCopy> = {
  "analysis.synthesis": {
    title: "Analysis — domain synthesis",
    description:
      "The main analysis pass. For each selected domain (Security, " +
      "Architecture, Data, DevOps, etc.) the engine reads the evidence " +
      "(questionnaire answers, documents, repo snippets) and produces " +
      "findings, risks, and recommendations. This is the most " +
      "token-heavy task in the system — one call per domain per " +
      "assessment, with 5–15k input tokens each.",
    operationalNote:
      "Quality-sensitive: downgrade with care. A weaker model here " +
      "shows up as thin findings and missed risks on the final report.",
  },
  "analysis.verifier": {
    title: "Analysis — verifier pass",
    description:
      "A second-opinion pass that re-reads the synthesis output and " +
      "flags claims that aren't grounded in the cited evidence. Acts " +
      "as an automated reviewer to reduce hallucinated findings before " +
      "the deliverable is generated.",
    operationalNote:
      "Runs once per domain after synthesis. Latency matters less than " +
      "accuracy — prefers a model comparable to the synthesis tier.",
  },
  "analysis.scoring": {
    title: "Analysis — maturity scoring",
    description:
      "Converts the synthesised findings into a 1–5 maturity score per " +
      "domain with a short rationale. Tighter, more structured output " +
      "than synthesis — responds well to smaller/faster models.",
    operationalNote:
      "Good candidate for a cheap model (Haiku / GPT-5-mini). The " +
      "prompt is short and the output is a few hundred tokens.",
  },
  "deliverable.section": {
    title: "Deliverable — section writer",
    description:
      "Generates long-form narrative sections for the final client " +
      "deliverable (executive summary, per-domain writeups, roadmap " +
      "commentary). Called once per section and benefits from prompt " +
      "caching because the system prompt is long and reused.",
    operationalNote:
      "Anthropic prompt caching is on for this task — the system " +
      "prompt is read-cached so each section writes at ~10% the " +
      "input-token cost of a cold call.",
  },
  "diagram.generate": {
    title: "Diagram — generate",
    description:
      "Generates Mermaid source for architecture / data-flow / " +
      "sequence diagrams referenced in the deliverable. Output is " +
      "plain text that the frontend then renders.",
    operationalNote:
      "Latency-tolerant; one-shot per diagram. A strong coding model " +
      "produces cleaner Mermaid than a smaller one.",
  },
  "diagram.parse": {
    title: "Diagram — parse from image",
    description:
      "Vision task. When an assessor uploads a screenshot of an " +
      "existing architecture diagram, this call reads the image and " +
      "extracts the boxes, arrows, and labels so the engine can " +
      "reason about them.",
    operationalNote:
      "Vision-only task — fallbacks need a provider with vision " +
      "support (Anthropic direct today; Vertex Gemini 2.5 Pro is the " +
      "planned second-line once credentials are provisioned).",
  },
  estimation: {
    title: "Estimation — roles & hours",
    description:
      "Produces a draft effort estimate (roles, hours, phases) based " +
      "on the assessed findings and the configured rate card. The " +
      "estimator then refines it manually.",
    operationalNote:
      "Output is structured JSON. Cheaper models are viable if the " +
      "rate card is well-defined.",
  },
  "followups.generate": {
    title: "Follow-ups — question generator",
    description:
      "When a gap in the evidence is detected, this task proposes " +
      "targeted follow-up questions for the assessor to send back to " +
      "the customer. Short prompt, short output.",
    operationalNote:
      "Cheap model is fine here — the prompt is tightly scoped and " +
      "reruns are cheap if results are weak.",
  },
  "agent.planner": {
    title: "Agent — planner",
    description:
      "Planning step for the multi-step agent harness (ADR-0014). " +
      "Picks the next autonomous tool call (e.g. github.read_file) " +
      "given the current run trajectory.",
    operationalNote:
      "Only fires when the agent harness is enabled. Quality matters " +
      "— a bad plan wastes downstream calls.",
  },
  "agent.workflow_planner": {
    title: "Agent — workflow planner",
    description:
      "One-shot planner that turns a user goal into a graph of " +
      "human-driven workflow steps (upload documents, connect " +
      "repositories, answer questions, run analysis). Renders as the " +
      "interactive React-Flow diagram on the assessment page.",
    operationalNote:
      "Only fires when the agent harness is enabled. Output quality " +
      "shapes the entire assessment surface — keep on a strong model.",
  },
  "template.binding_proposer": {
    title: "Template — binding proposer",
    description:
      "Proposes a JSON mapping from engine outputs (role hours, " +
      "rates, totals, assumptions, etc.) to cells / placeholders in a " +
      "customer-uploaded estimation workbook or deliverable doc.",
    operationalNote:
      "Fires once per template upload. The proposal is a draft — the " +
      "user reviews and approves before the binding goes live, so a " +
      "weaker model is fine for cost.",
  },
  "ingest.domain_classifier": {
    title: "Ingest — chunk domain classifier",
    description:
      "Reads each chunk text + the assessment's active domains and " +
      "picks the best-fit domain key per chunk. Runs after ingest " +
      "when the operator has enabled auto-classification, so the " +
      "Evidence Explorer's domain filter actually narrows results.",
    operationalNote:
      "Best-effort. Failure leaves the chunks in the catch-all bucket; " +
      "the analysis engine still reads them. Lightweight model is fine.",
  },
  "embedding.ingest": {
    title: "Embeddings — document ingest",
    description:
      "Turns document chunks into 1536-dimensional vectors during " +
      "ingestion so they can be searched by similarity later. Runs " +
      "once per chunk; the result is persisted to the pgvector index.",
    operationalNote:
      "The pgvector index is pinned at 1536 dimensions. Any fallback " +
      "here must return 1536-dim vectors or the router refuses to " +
      "write them (prevents silent index corruption).",
  },
  "embedding.query": {
    title: "Embeddings — retrieval query",
    description:
      "Turns a query string into a vector at search time so the RAG " +
      "retriever can pull the most relevant chunks. Runs on every " +
      "retrieval call during analysis.",
    operationalNote:
      "Intentionally has no fallback — mixing embedding spaces across " +
      "ingest vs. query would wreck cosine-similarity scores.",
  },
};

export const PROVIDER_COPY: Record<Provider, string> = {
  anthropic: "Anthropic (direct)",
  bedrock: "AWS Bedrock",
  openai: "OpenAI (direct)",
  azure: "Azure OpenAI",
  vertex: "Google Vertex AI",
  mistral: "Mistral",
};

/**
 * Known model-id → friendly display name. Covers every model present
 * in the default registry and the common fallbacks. Unknown ids fall
 * through and render the raw id — better than hiding an operator-set
 * override behind a misleading label.
 */
const MODEL_DISPLAY: Record<string, string> = {
  "claude-sonnet-4-7": "Claude Sonnet 4.7",
  "anthropic.claude-sonnet-4-7": "Claude Sonnet 4.7",
  "claude-sonnet-4-5": "Claude Sonnet 4.5",
  "anthropic.claude-sonnet-4-5": "Claude Sonnet 4.5",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "anthropic.claude-haiku-4-5": "Claude Haiku 4.5",
  "claude-opus-4-5": "Claude Opus 4.5",
  "gpt-5": "GPT-5",
  "gpt-5-mini": "GPT-5 mini",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "mistral-large-latest": "Mistral Large",
  "mistral-small-latest": "Mistral Small",
  "text-embedding-3-small": "OpenAI text-embedding-3-small",
  "amazon.titan-embed-text-v2:0": "Amazon Titan Embed v2",
};

export function modelDisplay(modelId: string): string {
  return MODEL_DISPLAY[modelId] ?? modelId;
}

/**
 * Curated per-provider list of model IDs an operator is likely to
 * pin in a hurry. Powers the `<datalist>` autocomplete under the
 * Model id field — the input stays free-text so any just-released
 * snapshot can still be typed verbatim, but the common choices are
 * one click away.
 *
 * Keep this aligned with `MODEL_DISPLAY` above and with the pricing
 * table in `server/services/ai/pricing.ts`: a model that appears
 * here but not in pricing shows up in the audit log with a $0 cost
 * estimate, which is mildly misleading. Azure is intentionally empty
 * — Azure "models" are actually operator-named deployments, so a
 * generic suggestion list would be wrong more often than right.
 */
export const MODEL_SUGGESTIONS: Record<Provider, readonly string[]> = {
  anthropic: [
    "claude-sonnet-4-7",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "claude-opus-4-5",
  ],
  bedrock: [
    "anthropic.claude-sonnet-4-7",
    "anthropic.claude-sonnet-4-5",
    "anthropic.claude-haiku-4-5",
    "amazon.titan-embed-text-v2:0",
  ],
  openai: ["gpt-5", "gpt-5-mini", "text-embedding-3-small"],
  azure: [],
  vertex: ["gemini-2.5-pro", "gemini-2.5-flash"],
  mistral: ["mistral-large-latest", "mistral-small-latest"],
};

export function providerDisplay(provider: Provider): string {
  return PROVIDER_COPY[provider] ?? provider;
}

/**
 * Compose the "currently running" sentence for a given binding +
 * fallback chain. Produces a single readable line like:
 *   Using Claude Sonnet 4.7 (Anthropic). If it fails, automatically
 *   tries Claude Sonnet 4.7 on AWS Bedrock, then GPT-5 (OpenAI).
 */
export function effectiveBindingSentence(
  primary: { provider: Provider; model: string },
  fallbacks: ReadonlyArray<{ provider: Provider; model: string }>,
): string {
  const head = `Currently using ${modelDisplay(primary.model)} (${providerDisplay(primary.provider)}).`;
  if (fallbacks.length === 0) {
    return `${head} No automatic fallback — a failure here surfaces as an error.`;
  }
  const chain = fallbacks
    .map((f) => `${modelDisplay(f.model)} on ${providerDisplay(f.provider)}`)
    .join(", then ");
  return `${head} If it fails (rate limit, outage, timeout), automatically retries on ${chain}.`;
}
