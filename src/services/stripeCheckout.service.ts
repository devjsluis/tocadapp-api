import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
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
  const client = await pool.connect();
  let locked = false;
  try {
    // Session lock spans the durable attempt write and the external Stripe call.
    await client.query("SELECT pg_advisory_lock(73421, $1)", [userId]);
    locked = true;
    const user = await client.query("SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL", [userId]);
    if (!user.rowCount) throw new Error("ACCOUNT_UNAVAILABLE");

    const planResult = await client.query<PlanRow>(
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

    const existing = await client.query<{
      provider: string; provider_subscription_id: string | null;
      status: string; current_period_end: Date | null;
    }>(
      `SELECT provider, provider_subscription_id, status, current_period_end
       FROM subscriptions WHERE user_id = $1`, [userId]);
    // Check every historical Stripe ID: a local EXPIRED row does not cancel billing.
    for (const row of existing.rows) {
      if (row.provider === "STRIPE" && row.provider_subscription_id) {
        const remote = await stripe.subscriptions.retrieve(row.provider_subscription_id);
        if (!["canceled", "incomplete_expired"].includes(remote.status)) {
          throw new Error("SUBSCRIPTION_ALREADY_EXISTS");
        }
        if (["PENDING", "ACTIVE", "PAST_DUE"].includes(row.status)) {
          throw new Error("CHECKOUT_RECONCILIATION_REQUIRED");
        }
      } else if (row.provider !== "TRIAL" &&
        ["PENDING", "ACTIVE", "PAST_DUE"].includes(row.status)) {
        throw new Error("SUBSCRIPTION_ALREADY_EXISTS");
      }
    }

    // Retire legacy open links too. Stripe Checkout sessions live at most 24h.
    // Pagination is intentional; never infer absence from only the first page.
    for await (const legacy of stripe.checkout.sessions.list({
      created: { gte: Math.floor(Date.now() / 1000) - 86400 }, limit: 100,
    })) {
      if (legacy.mode !== "subscription" || legacy.client_reference_id !== String(userId)) continue;
      if (legacy.status === "complete" && legacy.subscription) {
        const id = typeof legacy.subscription === "string" ? legacy.subscription : legacy.subscription.id;
        const remote = await stripe.subscriptions.retrieve(id);
        if (!["canceled", "incomplete_expired"].includes(remote.status)) throw new Error("SUBSCRIPTION_ALREADY_EXISTS");
      }
    }

    type Attempt = { idempotency_key: string; request: Stripe.Checkout.SessionCreateParams; session_id: string | null; created_at: Date };
    const saved = await client.query<Attempt>("SELECT * FROM stripe_checkout_attempts WHERE user_id = $1", [userId]);
    const attempt = saved.rows[0];
    if (attempt && Date.now() - new Date(attempt.created_at).getTime() >= 23 * 3600000 && !attempt.session_id) {
      // Never retry an ambiguous operation after Stripe's 24h key retention window.
      throw new Error("CHECKOUT_RECONCILIATION_REQUIRED");
    }
    if (attempt) {
      const previous = attempt.session_id
        ? await stripe.checkout.sessions.retrieve(attempt.session_id)
        : await stripe.checkout.sessions.create(attempt.request, { idempotencyKey: attempt.idempotency_key });
      await client.query("UPDATE stripe_checkout_attempts SET session_id = $2 WHERE user_id = $1", [userId, previous.id]);
      if (previous.status === "complete") {
        const id = typeof previous.subscription === "string" ? previous.subscription : previous.subscription?.id;
        if (!id) throw new Error("CHECKOUT_RECONCILIATION_REQUIRED");
        const remote = await stripe.subscriptions.retrieve(id);
        if (!["canceled", "incomplete_expired"].includes(remote.status)) throw new Error("SUBSCRIPTION_ALREADY_EXISTS");
      }
      if (previous.status === "open" && attempt.request.metadata?.planCode === planCode && previous.url) {
        return { checkoutUrl: previous.url, sessionId: previous.id };
      }
      if (previous.status === "open") await stripe.checkout.sessions.expire(previous.id);
      await client.query("DELETE FROM stripe_checkout_attempts WHERE user_id = $1", [userId]);
    }
    // No legacy link may remain payable in another tab when a new one is issued.
    for await (const legacy of stripe.checkout.sessions.list({ status: "open", created: { gte: Math.floor(Date.now() / 1000) - 86400 }, limit: 100 })) {
      if (legacy.mode === "subscription" && legacy.client_reference_id === String(userId)) {
        await stripe.checkout.sessions.expire(legacy.id);
      }
    }

    const webUrl = process.env.WEB_APP_URL;

    if (!webUrl) {
      throw new Error("WEB_APP_URL no está configurada");
    }

    const recurringInterval =
      plan.billing_interval === "YEAR" ? "year" : "month";

    const request: Stripe.Checkout.SessionCreateParams = {
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
    };
    const key = randomUUID();
    await client.query(
      "INSERT INTO stripe_checkout_attempts (user_id, idempotency_key, request) VALUES ($1, $2, $3)",
      [userId, key, JSON.stringify(request)],
    );
    const session = await stripe.checkout.sessions.create(request, { idempotencyKey: key });
    await client.query("UPDATE stripe_checkout_attempts SET session_id = $2 WHERE user_id = $1", [userId, session.id]);

    if (!session.url) {
      throw new Error("STRIPE_CHECKOUT_URL_MISSING");
    }

    return {
      checkoutUrl: session.url,
      sessionId: session.id,
    };
  } finally {
    try {
      if (locked) await client.query("SELECT pg_advisory_unlock(73421, $1)", [userId]);
    } catch (error) {
      // Do not return a connection with a session lock to the pool.
      client.release(true);
      throw error;
    }
    client.release();
  }
};
