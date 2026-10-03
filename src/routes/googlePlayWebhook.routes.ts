import { Router } from "express";
import { handleGooglePlayWebhook } from "../controllers/googlePlayWebhook.controller";

const router = Router();

router.post("/", handleGooglePlayWebhook);

export default router;
