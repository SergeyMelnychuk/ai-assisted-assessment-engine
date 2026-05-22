import { createRouter } from "./trpc";
import { engagementRouter } from "./routers/engagement";
import { assessmentRouter } from "./routers/assessment";
import { documentRouter } from "./routers/document";
import { questionRouter } from "./routers/question";
import { analysisRouter } from "./routers/analysis";
import { findingRouter } from "./routers/finding";
import { riskRouter } from "./routers/risk";
import { recommendationRouter } from "./routers/recommendation";
import { scoringRouter } from "./routers/scoring";
import { estimationRouter } from "./routers/estimation";
import { deliverableRouter } from "./routers/deliverable";
import { reviewRouter } from "./routers/review";
import { exportRouter } from "./routers/export";
import { evidenceExplorerRouter } from "./routers/evidenceExplorer";
import { healthRouter } from "./routers/health";
import { repositoryLinkRouter } from "./routers/repositoryLink";
import { costRouter } from "./routers/cost";
import { rateCardRouter } from "./routers/rate-card";
import { knowledgeArtifactRouter } from "./routers/knowledge-artifact";
import { adminLogsRouter } from "./routers/admin-logs";
import { adminSettingsRouter } from "./routers/admin-settings";
import { adminAiRouterRouter } from "./routers/admin-ai-router";
import { featuresRouter } from "./routers/features";
import { agentRunRouter } from "./routers/agentRun";
import { templateRouter } from "./routers/template";

export const appRouter = createRouter({
  health: healthRouter,
  features: featuresRouter,
  engagement: engagementRouter,
  assessment: assessmentRouter,
  document: documentRouter,
  question: questionRouter,
  analysis: analysisRouter,
  finding: findingRouter,
  risk: riskRouter,
  recommendation: recommendationRouter,
  scoring: scoringRouter,
  estimation: estimationRouter,
  deliverable: deliverableRouter,
  review: reviewRouter,
  export: exportRouter,
  repositoryLink: repositoryLinkRouter,
  evidenceExplorer: evidenceExplorerRouter,
  cost: costRouter,
  rateCard: rateCardRouter,
  knowledgeArtifact: knowledgeArtifactRouter,
  adminLogs: adminLogsRouter,
  adminSettings: adminSettingsRouter,
  adminAiRouter: adminAiRouterRouter,
  agentRun: agentRunRouter,
  template: templateRouter,
});

export type AppRouter = typeof appRouter;
