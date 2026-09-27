import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import {
  getCurrentSubscriptionByUserId,
  subscriptionGrantsAccess,
} from "../services/subscriptions.service";
import {
  createCheckoutSession,
  isCheckoutPlanCode,
} from "../services/stripeCheckout.service";

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


export const createSubscriptionCheckout = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const { planCode } = req.body;

    if (!isCheckoutPlanCode(planCode)) {
      return res.status(400).json({
        error: "Plan de suscripción inválido",
        code: "INVALID_PLAN",
      });
    }

    const result = await createCheckoutSession({
      userId: req.user!.id,
      email: req.user!.email,
      planCode,
    });

    return res.status(201).json(result);
  } catch (error) {
    console.error("Error al crear Checkout de Stripe:", error);

    if (error instanceof Error && error.message === "PLAN_NOT_FOUND") {
      return res.status(404).json({
        error: "El plan solicitado no está disponible",
        code: "PLAN_NOT_FOUND",
      });
    }

    return res.status(500).json({
      error: "No fue posible iniciar el proceso de pago",
      code: "CHECKOUT_CREATION_FAILED",
    });
  }
};
