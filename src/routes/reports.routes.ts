import { Router } from "express";
import { ReportsController } from "../controllers/ReportsController";

const router = Router();
const reportsController = new ReportsController();

router.get("/dashboard", (req, res) => reportsController.getDashboardStats(req, res));
router.get("/farm-mapping-stats", (req, res) => reportsController.getFarmMappingStats(req, res));

export default router;
