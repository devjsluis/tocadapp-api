import { Router } from "express";
import {
  cancelMySubscription,
  createSubscriptionCheckout,
  getMySubscription,
  reactivateMySubscription,
} from "../controllers/subscriptions.controller";
import { authMiddleware } from "../middleware/auth";

const router = Router();

router.get("/me", authMiddleware, getMySubscription);
router.post("/checkout", authMiddleware, createSubscriptionCheckout);
router.post("/cancel", authMiddleware, cancelMySubscription);
router.post("/reactivate", authMiddleware, reactivateMySubscription);

export default router;
