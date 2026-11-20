import { Router } from "express";
import { AssessmentQueueController } from "../controllers/AssessmentQueueController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";

const router = Router();
const controller = new AssessmentQueueController();

// Per-plot assessment status + deforestation finding for one farm.
// This is what the admin panel reads: it never starts an assessment itself.
router.get(
    "/farm/:farmId",
    authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR, UserRole.BUYER, UserRole.EXPORTER]),
    (req, res) => controller.forFarm(req, res),
);

// Queue overview: plots still queued or assessing.
router.get(
    "/outstanding",
    authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR]),
    (req, res) => controller.outstanding(req, res),
);

// Manual retry for a plot whose automatic check failed (authorised staff only).
router.post(
    "/retry/plot/:plotId",
    authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR]),
    (req, res) => controller.retryPlot(req, res),
);

// Manual retry for a specific job.
router.post(
    "/retry/job/:jobId",
    authMiddleware([UserRole.ADMIN, UserRole.INSPECTOR]),
    (req, res) => controller.retryJob(req, res),
);

export default router;
