import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import {
  getCurrentSubscriptionByUserId,
  subscriptionGrantsAccess,
} from "../services/subscriptions.service";

export const getMySubscription = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const subscription = await getCurrentSubscriptionByUserId(req.user!.id);

    return res.json({
      hasAccess: subscriptionGrantsAccess(subscription),
      subscription,
    });
  } catch (error) {
    console.error("Error al consultar la suscripción:", error);

    return res.status(500).json({
      error: "No fue posible consultar la suscripción",
    });
  }
};
