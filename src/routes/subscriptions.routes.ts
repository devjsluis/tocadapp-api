import { Router } from "express";
import {
  createSubscriptionCheckout,
  getMySubscription,
} from "../controllers/subscriptions.controller";
import { authMiddleware } from "../middleware/auth";

const router = Router();

router.get("/me", authMiddleware, getMySubscription);
router.post("/checkout", authMiddleware, createSubscriptionCheckout);

export default router;
