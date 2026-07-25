import type { NextFunction, Request, Response } from "express";
import {
  getCurrentSubscriptionByUserId,
  subscriptionGrantsAccess,
} from "../services/subscriptions.service";

export const requireActiveSubscription = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        error: "No autorizado",
      });
    }

    const subscription = await getCurrentSubscriptionByUserId(userId);

    if (!subscription || !subscriptionGrantsAccess(subscription)) {
      return res.status(403).json({
        error: "Se requiere una suscripción activa",
        code: "SUBSCRIPTION_REQUIRED",
      });
    }

    return next();
  } catch (error) {
    console.error("Error validando suscripción:", error);

    return res.status(500).json({
      error: "No fue posible validar la suscripción",
    });
  }
};
