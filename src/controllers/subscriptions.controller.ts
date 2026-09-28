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
import {
  cancelStripeSubscriptionAtPeriodEnd,
  reactivateStripeSubscription,
} from "../services/stripeSubscriptionManagement.service";

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
    console.error("Error al consultar la suscripciÃ³n:", error);

    return res.status(500).json({
      error: "No fue posible consultar la suscripciÃ³n",
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
        error: "Plan de suscripciÃ³n invÃ¡lido",
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
        error: "El plan solicitado no estÃ¡ disponible",
        code: "PLAN_NOT_FOUND",
      });
    }

    return res.status(500).json({
      error: "No fue posible iniciar el proceso de pago",
      code: "CHECKOUT_CREATION_FAILED",
    });
  }
};


const handleStripeManagementError = (
  error: unknown,
  res: Response,
) => {
  if (
    error instanceof Error &&
    (error.message === "STRIPE_SUBSCRIPTION_NOT_FOUND" ||
      error.message === "STRIPE_SUBSCRIPTION_ID_MISSING")
  ) {
    return res.status(404).json({
      error: "No se encontró una suscripción de Stripe administrable",
      code: "STRIPE_SUBSCRIPTION_NOT_FOUND",
    });
  }

  console.error("Error administrando suscripción de Stripe:", error);

  return res.status(500).json({
    error: "No fue posible administrar la suscripción",
    code: "SUBSCRIPTION_MANAGEMENT_FAILED",
  });
};

export const cancelMySubscription = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const result = await cancelStripeSubscriptionAtPeriodEnd(req.user!.id);

    return res.json({
      message: "La suscripción se cancelará al finalizar el periodo actual",
      ...result,
    });
  } catch (error) {
    return handleStripeManagementError(error, res);
  }
};

export const reactivateMySubscription = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const result = await reactivateStripeSubscription(req.user!.id);

    return res.json({
      message: "La renovación automática fue reactivada",
      ...result,
    });
  } catch (error) {
    return handleStripeManagementError(error, res);
  }
};
