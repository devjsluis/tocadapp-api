import { pool } from "../lib/db";
import { stripe } from "../lib/stripe";

const ALLOWED_PLAN_CODES = [
  "TOCADAPP_MONTHLY",
  "TOCADAPP_YEARLY",
] as const;

export type CheckoutPlanCode = (typeof ALLOWED_PLAN_CODES)[number];

type PlanRow = {
  id: string;
  code: CheckoutPlanCode;
  name: string;
  description: string | null;
  price_amount: number;
  currency: string;
  billing_interval: "MONTH" | "YEAR";
  interval_count: number;
};

type CreateCheckoutSessionInput = {
  userId: number;
  email: string;
  planCode: CheckoutPlanCode;
};

export const isCheckoutPlanCode = (
  value: unknown,
): value is CheckoutPlanCode =>
  typeof value === "string" &&
  ALLOWED_PLAN_CODES.includes(value as CheckoutPlanCode);

export const createCheckoutSession = async ({
  userId,
  email,
  planCode,
}: CreateCheckoutSessionInput) => {
  const planResult = await pool.query<PlanRow>(
    `
      SELECT
        id,
        code,
        name,
        description,
        price_amount,
        currency,
        billing_interval,
        interval_count
      FROM plans
      WHERE code = $1
        AND active = TRUE
      LIMIT 1
    `,
    [planCode],
  );

  if (planResult.rowCount === 0) {
    throw new Error("PLAN_NOT_FOUND");
  }

  const plan = planResult.rows[0];

  const webUrl = process.env.WEB_APP_URL;

  if (!webUrl) {
    throw new Error("WEB_APP_URL no está configurada");
  }

  const recurringInterval =
    plan.billing_interval === "YEAR" ? "year" : "month";

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",

    customer_email: email,

    client_reference_id: String(userId),

    line_items: [
      {
        price_data: {
          currency: plan.currency.toLowerCase(),
          unit_amount: plan.price_amount,
          recurring: {
            interval: recurringInterval,
            interval_count: plan.interval_count,
          },
          product_data: {
            name: plan.name,
            ...(plan.description
              ? { description: plan.description }
              : {}),
          },
        },
        quantity: 1,
      },
    ],

    metadata: {
      userId: String(userId),
      planCode: plan.code,
    },

    subscription_data: {
      metadata: {
        userId: String(userId),
        planCode: plan.code,
      },
    },

    success_url: `${webUrl}/subscription-required?checkout=success`,
    cancel_url: `${webUrl}/subscription-required?checkout=canceled`,
  });

  if (!session.url) {
    throw new Error("STRIPE_CHECKOUT_URL_MISSING");
  }

  return {
    checkoutUrl: session.url,
    sessionId: session.id,
  };
};
