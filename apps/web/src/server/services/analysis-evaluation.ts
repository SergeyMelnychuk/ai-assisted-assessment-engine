export interface RetrievalEvaluationCase {
  name: string;
  expectedEvidenceIds: string[];
  retrievedEvidenceIds: string[];
}

export interface RetrievalCaseResult {
  name: string;
  precisionAtK: number;
  recallAtK: number;
  reciprocalRank: number;
}

export interface RetrievalEvaluationSummary {
  cases: RetrievalCaseResult[];
  meanPrecisionAtK: number;
  meanRecallAtK: number;
  meanReciprocalRank: number;
}

export interface ScoreBandEvaluationCase {
  name: string;
  actualScore: number;
  expectedMin: number;
  expectedMax: number;
}

export interface ScoreBandCaseResult {
  name: string;
  withinBand: boolean;
  distanceToBand: number;
}

export interface ScoreBandEvaluationSummary {
  cases: ScoreBandCaseResult[];
  passRate: number;
  meanDistanceToBand: number;
}

export function evaluateRetrievalCases(
  cases: RetrievalEvaluationCase[],
): RetrievalEvaluationSummary {
  const results = cases.map(evaluateRetrievalCase);
  return {
    cases: results,
    meanPrecisionAtK: average(results.map((r) => r.precisionAtK)),
    meanRecallAtK: average(results.map((r) => r.recallAtK)),
    meanReciprocalRank: average(results.map((r) => r.reciprocalRank)),
  };
}

export function evaluateScoreBandCases(
  cases: ScoreBandEvaluationCase[],
): ScoreBandEvaluationSummary {
  const results = cases.map(evaluateScoreBandCase);
  return {
    cases: results,
    passRate: average(results.map((r) => (r.withinBand ? 1 : 0))),
    meanDistanceToBand: average(results.map((r) => r.distanceToBand)),
  };
}

export function evaluateRetrievalCase(
  input: RetrievalEvaluationCase,
): RetrievalCaseResult {
  const expected = new Set(input.expectedEvidenceIds);
  const retrieved = input.retrievedEvidenceIds;
  const hits = retrieved.filter((id) => expected.has(id)).length;
  const firstHitIndex = retrieved.findIndex((id) => expected.has(id));

  return {
    name: input.name,
    precisionAtK: retrieved.length > 0 ? hits / retrieved.length : 0,
    recallAtK: expected.size > 0 ? hits / expected.size : 0,
    reciprocalRank: firstHitIndex >= 0 ? 1 / (firstHitIndex + 1) : 0,
  };
}

export function evaluateScoreBandCase(
  input: ScoreBandEvaluationCase,
): ScoreBandCaseResult {
  const withinBand =
    input.actualScore >= input.expectedMin &&
    input.actualScore <= input.expectedMax;
  const distanceToBand = withinBand
    ? 0
    : input.actualScore < input.expectedMin
      ? input.expectedMin - input.actualScore
      : input.actualScore - input.expectedMax;

  return {
    name: input.name,
    withinBand,
    distanceToBand,
  };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
