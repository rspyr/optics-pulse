import { Router, type IRouter } from "express";
import { requireAuth, enforceTenantScope } from "../middleware/auth";
import healthRouter from "./health";
import authRouter from "./auth";
import tenantsRouter from "./tenants";
import leadsRouter from "./leads";
import campaignsRouter from "./campaigns";
import attributionRouter from "./attribution";
import jobsRouter from "./jobs";
import webhooksRouter from "./webhooks";
import dashboardRouter from "./dashboard";
import adminRouter from "./admin";
import adminBackgroundJobsRouter from "./admin-background-jobs";
import changeLogsRouter from "./change-logs";
import integrationsRouter from "./integrations";
import chatRouter from "./chat";
import trainingRouter from "./training";
import automationRouter from "./automation";
import funnelTypesRouter from "./funnel-types";
import trackerRouter from "./tracker";
import trackerDiagnosticsRouter from "./tracker-diagnostics";
import trackerInstallSnippetRouter from "./tracker-install-snippet";
import callAttemptsRouter from "./call-attempts";
import drilldownRouter from "./drilldown";
import budgetRouter from "./budget";
import reviewsRouter from "./reviews";
import scriptsRouter from "./scripts";
import salesManagerRouter from "./sales-manager";
import leadsHubRouter from "./leads-hub";
import googleSheetsIngestRouter from "./google-sheets-ingest";
import sheetConfigsRouter from "./sheet-configs";
import unroutedSheetRowsRouter from "./unrouted-sheet-rows";
import leadSourceAliasesRouter from "./lead-source-aliases";
import funnelAliasesRouter from "./funnel-aliases";
import fieldMappingRulesRouter from "./field-mapping-rules";
import subdomainFunnelRulesRouter from "./subdomain-funnel-rules";
import routeFunnelRulesRouter from "./route-funnel-rules";
import ingestionModeRouter from "./ingestion-mode";
import verifyTrackerRouter from "./verify-tracker";
import googleOAuthRouter from "./google-oauth";
import metaOAuthRouter from "./meta-oauth";
import metaAccountsRouter from "./meta-accounts";
import podiumOAuthRouter from "./podium-oauth";
import podiumRoutesRouter from "./podium-routes";
import pushTokensRouter from "./push-tokens";
import webPushRouter from "./web-push";
import notificationsRouter from "./notifications";
import usersRouter from "./users";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(webhooksRouter);
router.use(trackerRouter);
router.use(trackerDiagnosticsRouter);

router.use(googleOAuthRouter);
router.use(metaOAuthRouter);
router.use(podiumOAuthRouter);

router.use(requireAuth);

router.use(usersRouter);

router.use(enforceTenantScope);

router.use(reviewsRouter);

router.use(trackerInstallSnippetRouter);
router.use(tenantsRouter);
router.use(leadsRouter);
router.use(campaignsRouter);
router.use(attributionRouter);
router.use(jobsRouter);
router.use(dashboardRouter);
router.use(adminRouter);
router.use(adminBackgroundJobsRouter);
router.use(changeLogsRouter);
router.use(integrationsRouter);
router.use(metaAccountsRouter);
router.use(chatRouter);
router.use(trainingRouter);
router.use(automationRouter);
router.use(funnelTypesRouter);
router.use(callAttemptsRouter);
router.use(drilldownRouter);
router.use(budgetRouter);
router.use(scriptsRouter);
router.use(salesManagerRouter);
router.use(leadsHubRouter);
router.use(googleSheetsIngestRouter);
router.use(sheetConfigsRouter);
router.use(unroutedSheetRowsRouter);
router.use(leadSourceAliasesRouter);
router.use(funnelAliasesRouter);
router.use(fieldMappingRulesRouter);
router.use(subdomainFunnelRulesRouter);
router.use(routeFunnelRulesRouter);
router.use(ingestionModeRouter);
router.use(verifyTrackerRouter);
router.use(podiumRoutesRouter);
router.use(pushTokensRouter);
router.use(webPushRouter);
router.use(notificationsRouter);

export default router;

