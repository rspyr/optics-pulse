import { Router, type IRouter } from "express";
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

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(tenantsRouter);
router.use(leadsRouter);
router.use(campaignsRouter);
router.use(attributionRouter);
router.use(jobsRouter);
router.use(webhooksRouter);
router.use(dashboardRouter);
router.use(adminRouter);

export default router;
