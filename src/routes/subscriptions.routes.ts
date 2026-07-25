import { Router } from "express";
import { getMySubscription } from "../controllers/subscriptions.controller";
import { authMiddleware } from "../middleware/auth";

const router = Router();

router.get("/me", authMiddleware, getMySubscription);

export default router;
