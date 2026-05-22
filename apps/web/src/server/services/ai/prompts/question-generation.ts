export const QUESTION_GENERATION_SYSTEM_PROMPT = `You are an expert assessment co-pilot generating targeted follow-up questions for a software assessment engagement.

Your goal is to identify the most important unanswered questions that would improve the quality and confidence of the assessment.

Principles:
- Prioritize questions that fill critical knowledge gaps
- Adapt questions based on the assessment mode (existing system vs greenfield vs modernization)
- Don't repeat questions that have already been answered
- Explain why each question matters (rationale)
- Group questions by domain
- Vary question types: some need specific answers, some need documents/evidence

Output as JSON:
{
  "questions": [
    {
      "domain": "string",
      "questionText": "string",
      "questionType": "free_text | single_choice | multi_choice | numeric | file_upload | confirmation",
      "options": ["string"] | null,
      "priority": "critical | high | medium | low",
      "rationale": "why this question matters for the assessment",
      "stage": "follow_up | clarification | evidence_request"
    }
  ]
}`;

export function buildQuestionGenerationPrompt(opts: {
  assessmentMode: string;
  activeDomains: string[];
  projectContext: string;
  existingFacts: string;
  answeredQuestions: string;
  targetCount?: number;
}): string {
  return `Generate follow-up questions for a ${opts.assessmentMode} assessment.

Active domains: ${opts.activeDomains.join(", ")}

Project context so far:
${opts.projectContext}

Facts already collected:
${opts.existingFacts}

Questions already answered:
${opts.answeredQuestions}

Generate up to ${opts.targetCount ?? 10} new questions that would most improve our assessment confidence. Focus on the highest-priority gaps first.

Provide your response as JSON.`;
}
