/**
 * Analysis execution mode — user-selectable at "Run analysis" time
 * (ADR-0013). Threaded from the UI through the tRPC mutation into the
 * BullMQ job payload and finally into `runAnalysis` / `runOneDomain`.
 *
 *   - **FAST**     — one Claude call per domain (the generator). Lower
 *                    cost / shorter wall-clock; output is whatever the
 *                    generator produced, un-filtered.
 *   - **THOROUGH** — generator + a second "verifier" Claude call per
 *                    domain that drops weakly-supported items. Roughly
 *                    2× the Claude spend and ~2× the wall-clock, but
 *                    measurably tighter output.
 *
 * Exposed as an enum-style literal union so zod validators, Prisma
 * JSON columns, and the React UI all share a single spelling.
 */
export const ANALYSIS_MODES = ["FAST", "THOROUGH"] as const;
export type AnalysisMode = (typeof ANALYSIS_MODES)[number];

export const DEFAULT_ANALYSIS_MODE: AnalysisMode = "FAST";

export function isAnalysisMode(value: unknown): value is AnalysisMode {
  return (
    typeof value === "string" &&
    (ANALYSIS_MODES as readonly string[]).includes(value)
  );
}
