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
import changeLogsRouter from "./change-logs";
import integrationsRouter from "./integrations";
import chatRouter from "./chat";
import trainingRouter from "./training";
import automationRouter from "./automation";
import funnelTypesRouter from "./funnel-types";
import trackerRouter from "./tracker";
import callAttemptsRouter from "./call-attempts";
import drilldownRouter from "./drilldown";
import budgetRouter from "./budget";
import reviewsRouter from "./reviews";
import scriptsRouter from "./scripts";
import salesManagerRouter from "./sales-manager";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(webhooksRouter);
router.use(trackerRouter);

router.use(requireAuth);

router.use(enforceTenantScope);

router.use(reviewsRouter);

router.use(tenantsRouter);
router.use(leadsRouter);
router.use(campaignsRouter);
router.use(attributionRouter);
router.use(jobsRouter);
router.use(dashboardRouter);
router.use(adminRouter);
router.use(changeLogsRouter);
router.use(integrationsRouter);
router.use(chatRouter);
router.use(trainingRouter);
router.use(automationRouter);
router.use(funnelTypesRouter);
router.use(callAttemptsRouter);
router.use(drilldownRouter);
router.use(budgetRouter);
router.use(scriptsRouter);
router.use(salesManagerRouter);

export default router;

