import { Request, Response } from "express";
import Stripe from "stripe";
import { stripe } from "../lib/stripe";
import { processStripeEvent } from "../services/stripeWebhook.service";

export const handleStripeWebhook = async (
  req: Request,
  res: Response,
) => {
  const signature = req.headers["stripe-signature"];

  if (!signature) {
    return res.status(400).json({
      error: "Falta la firma de Stripe",
    });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("STRIPE_WEBHOOK_SECRET no está configurada");

    return res.status(500).json({
      error: "Webhook de Stripe no configurado",
    });
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      webhookSecret,
    );
  } catch (error) {
    console.error(
      "Firma de webhook Stripe inválida:",
      error instanceof Error ? error.message : error,
    );

    return res.status(400).json({
      error: "Firma de Stripe inválida",
    });
  }

  console.log(
    `[Stripe webhook] ${event.type} - ${event.id}`,
  );

  try {
    const result = await processStripeEvent(event);

    return res.status(200).json({
      received: true,
      duplicate: result.duplicate,
    });
  } catch (error) {
    console.error(
      `[Stripe webhook] Error procesando ${event.type} - ${event.id}:`,
      error,
    );

    return res.status(500).json({
      error: "No fue posible procesar el webhook de Stripe",
    });
  }
};
