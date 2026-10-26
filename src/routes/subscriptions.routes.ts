import { Router } from "express";
import {
  cancelMySubscription,
  createSubscriptionCheckout,
  getMySubscription,
  getMyGooglePlayBillingIdentity,
  reactivateMySubscription,
  verifyGooglePlaySubscription,
} from "../controllers/subscriptions.controller";
import { authMiddleware } from "../middleware/auth";

const router = Router();

router.get("/me", authMiddleware, getMySubscription);
router.get("/google-play/identity", authMiddleware, getMyGooglePlayBillingIdentity);
router.post("/checkout", authMiddleware, createSubscriptionCheckout);
router.post(
  "/google-play/verify",
  authMiddleware,
  verifyGooglePlaySubscription,
);
router.post("/cancel", authMiddleware, cancelMySubscription);
router.post("/reactivate", authMiddleware, reactivateMySubscription);

export default router;
