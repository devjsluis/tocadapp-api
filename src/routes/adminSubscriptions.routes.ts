import { Router } from "express";
import {
  editSubscriptionPayment,
  grantManualSubscriptionAccess,
  listAdminSubscriptions,
  listUserSubscriptionPayments,
  removeSubscriptionPayment,
} from "../controllers/adminSubscriptions.controller";
import { authMiddleware } from "../middleware/auth";
import { requireAdmin } from "../middleware/requireAdmin";

const router = Router();

router.use(authMiddleware);
router.use(requireAdmin);

router.get("/", listAdminSubscriptions);

router.post("/grant", grantManualSubscriptionAccess);

router.put("/payments/:paymentId", editSubscriptionPayment);

router.delete("/payments/:paymentId", removeSubscriptionPayment);

router.get("/:userId/payments", listUserSubscriptionPayments);

export default router;
