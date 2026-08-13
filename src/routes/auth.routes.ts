import { Router } from "express";
import { AuthController } from "../controllers/AuthController";
import { authMiddleware } from "../middleware/auth.middleware";
import { UserRole } from "../entities/User";

const router = Router();
const authController = new AuthController();

router.post("/login", (req, res) => authController.login(req, res));

router.post("/forget-password", (req, res) => authController.forgotPassword(req, res));
router.post("/reset-password", (req, res) => authController.resetPassword(req, res));
import { upload } from "../middleware/upload.middleware";

router.post("/register-farmer", upload.any(), (req, res) => authController.registerFarmer(req, res));
router.get("/pending", authMiddleware([UserRole.ADMIN]), (req, res) => authController.getPendingUsers(req, res));
router.put("/approve/:id", authMiddleware([UserRole.ADMIN]), (req, res) => authController.approveUser(req, res));
router.put("/reject/:id", authMiddleware([UserRole.ADMIN]), (req, res) => authController.rejectUser(req, res));

export default router;
