import { Router } from "express";
import {
  grantManualSubscriptionAccess,
  listAdminSubscriptions,
  listUserSubscriptionPayments,
} from "../controllers/adminSubscriptions.controller";
import { authMiddleware } from "../middleware/auth";
import { requireAdmin } from "../middleware/requireAdmin";

const router = Router();

router.use(authMiddleware);
router.use(requireAdmin);

router.get("/", listAdminSubscriptions);

router.post("/grant", grantManualSubscriptionAccess);

router.get("/:userId/payments", listUserSubscriptionPayments);

export default router;
