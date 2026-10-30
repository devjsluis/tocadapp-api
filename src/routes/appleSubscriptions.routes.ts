import { Router, type Response } from "express";
import rateLimit from "express-rate-limit";
import { Environment } from "@apple/app-store-server-library";
import { authMiddleware, type AuthRequest } from "../middleware/auth";
import { appleStore } from "../lib/apple";
import { getAppleBillingIdentity, syncAppleSubscription } from "../services/appleSubscription.service";
import { getCurrentSubscriptionByUserId, subscriptionGrantsAccess } from "../services/subscriptions.service";

const limit = rateLimit({ windowMs: 60_000, limit: 30 });
function failure(error: unknown, res: Response) {
  const code = error instanceof Error ? error.message : "APPLE_VERIFICATION_FAILED";
  const conflict = ["APPLE_PURCHASE_ACCOUNT_CONFLICT", "APPLE_OTHER_SUBSCRIPTION_ACTIVE"].includes(code);
  const invalid = code === "INVALID_APPLE_PURCHASE";
  return res.status(conflict ? 409 : invalid ? 400 : 503).json({
    error: conflict ? "La compra corresponde a otra cuenta o ya tienes otra suscripción activa." : "No fue posible comprobar la compra con Apple.",
    code: conflict || invalid ? code : "APPLE_SERVICE_UNAVAILABLE", retryable: !conflict && !invalid,
  });
}
export const appleSubscriptionsRouter = Router();
appleSubscriptionsRouter.use(authMiddleware, limit);
appleSubscriptionsRouter.get("/identity", async (req: AuthRequest, res) => {
  res.setHeader("Cache-Control", "no-store");
  try { res.json(await getAppleBillingIdentity(req.user!.id)); } catch (error) { failure(error, res); }
});
appleSubscriptionsRouter.post("/verify", async (req: AuthRequest, res) => {
  res.setHeader("Cache-Control", "no-store");
  const id = req.body?.transactionId;
  if (typeof id !== "string" || !/^\d{1,40}$/.test(id)) {
    res.status(400).json({ code: "INVALID_APPLE_PURCHASE", retryable: false }); return;
  }
  try {
    const result = await syncAppleSubscription(id, req.user!.id);
    const subscription = await getCurrentSubscriptionByUserId(req.user!.id);
    res.json({ hasAccess: subscriptionGrantsAccess(subscription), subscription, purchaseResult: result.purchaseResult });
  } catch (error) { failure(error, res); }
});

export const appleNotificationsRouter = Router();
appleNotificationsRouter.post("/", rateLimit({ windowMs: 60_000, limit: 300 }), async (req, res) => {
  const payload = req.body?.signedPayload;
  if (typeof payload !== "string" || payload.length > 100_000) { res.sendStatus(400); return; }
  try {
    // The untrusted hint selects a verifier only. That verifier must authenticate
    // the entire payload, bundle and environment before any state can change.
    const hint = JSON.parse(Buffer.from(payload.split(".")[1] ?? "", "base64url").toString("utf8"));
    const environment = hint.data?.environment ?? hint.summary?.environment;
    if (environment !== Environment.SANDBOX && environment !== Environment.PRODUCTION) { res.sendStatus(400); return; }
    const { verifier } = appleStore(environment);
    const notification = await verifier.verifyAndDecodeNotification(payload);
    if (notification.notificationType === "TEST") { res.sendStatus(200); return; }
    if (!notification.data?.signedTransactionInfo) { res.sendStatus(200); return; }
    const tx = await verifier.verifyAndDecodeTransaction(notification.data.signedTransactionInfo);
    if (!tx.transactionId) { res.sendStatus(400); return; }
    await syncAppleSubscription(tx.transactionId, undefined, environment);
    res.sendStatus(200);
  } catch {
    // No acknowledgement on verification/persistence failure: Apple retries delivery.
    res.sendStatus(503);
  }
});
