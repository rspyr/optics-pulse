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

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(webhooksRouter);

router.use(requireAuth);

router.use(enforceTenantScope);

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

export default router;
