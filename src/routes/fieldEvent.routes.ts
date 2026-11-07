import { Router } from "express";
import { FieldEventController } from "../controllers/FieldEventController";
import { authMiddleware } from "../middleware/auth.middleware";

const router = Router();
const controller = new FieldEventController();

// Check-in/check-out is a self-reported action by whichever authenticated
// staff member is performing it - the enumerator is always derived from
// the token (req.user.id), never from the request body, so no specific
// role allowlist is needed here (mirrors the "any authenticated web staff
// may report their own heartbeat" principle, extended to field events).
router.post("/check-in", authMiddleware(), (req, res) => controller.checkIn(req, res));
router.post("/check-out", authMiddleware(), (req, res) => controller.checkOut(req, res));

export default router;
