import { Router, type IRouter } from "express";
import healthRouter from "./health";
import tenantsRouter from "./tenants";
import leadsRouter from "./leads";
import campaignsRouter from "./campaigns";
import attributionRouter from "./attribution";
import jobsRouter from "./jobs";
import webhooksRouter from "./webhooks";
import dashboardRouter from "./dashboard";

const router: IRouter = Router();

router.use(healthRouter);
router.use(tenantsRouter);
router.use(leadsRouter);
router.use(campaignsRouter);
router.use(attributionRouter);
router.use(jobsRouter);
router.use(webhooksRouter);
router.use(dashboardRouter);

export default router;
