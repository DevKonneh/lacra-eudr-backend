import { Router } from "express";
import { LicenseController } from "../controllers/LicenseController";
import { authMiddleware } from "../middleware/auth.middleware";

const router = Router();
const licenseController = new LicenseController();

router.post("/apply", authMiddleware(), (req, res) => licenseController.apply(req, res));
router.post("/:id/submit", authMiddleware(), (req, res) => licenseController.submit(req, res));
router.post("/:id/recommend", authMiddleware(), (req, res) => licenseController.recommend(req, res)); // Commercial review
router.post("/:id/approve", authMiddleware(), (req, res) => licenseController.approve(req, res)); // DG decision
router.post("/:id/issue", authMiddleware(), (req, res) => licenseController.issue(req, res)); // Finance issuance
router.get("/", authMiddleware(), (req, res) => licenseController.getAll(req, res));
router.get("/my-licenses", authMiddleware(), (req, res) => licenseController.getMyLicenses(req, res));

export default router;
