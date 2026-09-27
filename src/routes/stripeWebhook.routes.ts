import { Router } from "express";
import { handleStripeWebhook } from "../controllers/stripeWebhook.controller";

const router = Router();

router.post("/", handleStripeWebhook);

export default router;
