import Stripe from "stripe";
import type { PoolClient } from "pg";
import { pool } from "../lib/db";
import { stripe } from "../lib/stripe";

type TocadAppSubscriptionStatus =
  | "PENDING"
  | "ACTIVE"
  | "PAST_DUE"
  | "CANCELED"
  | "EXPIRED";

const unixToDate = (timestamp: number): Date =>
  new Date(timestamp * 1000);

const getStripeId = (
  value:
    | string
    | { id: string }
    | null
    | undefined,
): string | null => {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
};

const mapStripeStatus = (
  status: Stripe.Subscription.Status,
): TocadAppSubscriptionStatus => {
  switch (status) {
    case "active":
    case "trialing":
      return "ACTIVE";

    case "past_due":
      return "PAST_DUE";

    case "canceled":
      return "CANCELED";

    case "incomplete":
      return "PENDING";

    case "incomplete_expired":
    case "unpaid":
    case "paused":
      return "EXPIRED";

    default:
      return "PENDING";
  }
};

const getSubscriptionPeriod = (
  subscription: Stripe.Subscription,
) => {
  const item = subscription.items.data[0];

  if (!item) {
    throw new Error("STRIPE_SUBSCRIPTION_WITHOUT_ITEMS");
  }

  return {
    start: unixToDate(item.current_period_start),
    end: unixToDate(item.current_period_end),
  };
};

const getSubscriptionIdFromInvoice = (
  invoice: Stripe.Invoice,
): string | null => {
  const parent = invoice.parent;

  if (
    !parent ||
    parent.type !== "subscription_details" ||
    !parent.subscription_details
  ) {
    return null;
  }

  return getStripeId(parent.subscription_details.subscription);
};

const getPlanCodeFromSubscription = (
  subscription: Stripe.Subscription,
): string | null => {
  return subscription.metadata.planCode || null;
};

const getUserIdFromSubscription = (
  subscription: Stripe.Subscription,
): number | null => {
  const rawUserId = subscription.metadata.userId;

  if (!rawUserId) return null;

  const userId = Number(rawUserId);

  if (!Number.isInteger(userId) || userId <= 0) {
    return null;
  }

  return userId;
};

const closeExistingOpenSubscription = async (
  client: PoolClient,
  userId: number,
  exceptProviderSubscriptionId: string,
) => {
  await client.query(
    `
      UPDATE subscriptions
      SET
        status = 'EXPIRED',
        ended_at = COALESCE(ended_at, NOW()),
        cancel_at_period_end = FALSE
      WHERE user_id = $1
        AND status IN ('PENDING', 'ACTIVE', 'PAST_DUE')
        AND (
          provider <> 'STRIPE'
          OR provider_subscription_id IS DISTINCT FROM $2
        )
    `,
    [userId, exceptProviderSubscriptionId],
  );
};

const upsertStripeSubscription = async (
  client: PoolClient,
  subscription: Stripe.Subscription,
) => {
  const userId = getUserIdFromSubscription(subscription);
  const planCode = getPlanCodeFromSubscription(subscription);

  if (!userId || !planCode) {
    throw new Error("STRIPE_SUBSCRIPTION_METADATA_MISSING");
  }

  const planResult = await client.query<{
    id: string;
    price_amount: number;
    currency: string;
  }>(
    `
      SELECT id, price_amount, currency
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
  const period = getSubscriptionPeriod(subscription);
  const status = mapStripeStatus(subscription.status);
  const customerId = getStripeId(subscription.customer);

  await closeExistingOpenSubscription(
    client,
    userId,
    subscription.id,
  );

  const existingResult = await client.query<{ id: number }>(
    `
      SELECT id
      FROM subscriptions
      WHERE provider = 'STRIPE'
        AND provider_subscription_id = $1
      LIMIT 1
      FOR UPDATE
    `,
    [subscription.id],
  );

  if (existingResult.rowCount) {
    const subscriptionId = existingResult.rows[0].id;

    await client.query(
      `
        UPDATE subscriptions
        SET
          plan_id = $1,
          status = $2,
          provider_customer_id = $3,
          price_amount = $4,
          currency = $5,
          started_at = COALESCE(started_at, $6),
          current_period_start = $7,
          current_period_end = $8,
          cancel_at_period_end = $9,
          canceled_at = $10,
          ended_at = $11
        WHERE id = $12
      `,
      [
        plan.id,
        status,
        customerId,
        plan.price_amount,
        plan.currency,
        unixToDate(subscription.start_date),
        period.start,
        period.end,
        subscription.cancel_at_period_end,
        subscription.canceled_at
          ? unixToDate(subscription.canceled_at)
          : null,
        subscription.ended_at
          ? unixToDate(subscription.ended_at)
          : null,
        subscriptionId,
      ],
    );

    return {
      subscriptionId,
      userId,
      period,
    };
  }

  const insertResult = await client.query<{ id: number }>(
    `
      INSERT INTO subscriptions (
        user_id,
        plan_id,
        status,
        provider,
        provider_customer_id,
        provider_subscription_id,
        price_amount,
        currency,
        started_at,
        current_period_start,
        current_period_end,
        cancel_at_period_end,
        canceled_at,
        ended_at
      )
      VALUES (
        $1, $2, $3, 'STRIPE', $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13
      )
      RETURNING id
    `,
    [
      userId,
      plan.id,
      status,
      customerId,
      subscription.id,
      plan.price_amount,
      plan.currency,
      unixToDate(subscription.start_date),
      period.start,
      period.end,
      subscription.cancel_at_period_end,
      subscription.canceled_at
        ? unixToDate(subscription.canceled_at)
        : null,
      subscription.ended_at
        ? unixToDate(subscription.ended_at)
        : null,
    ],
  );

  return {
    subscriptionId: insertResult.rows[0].id,
    userId,
    period,
  };
};

const handleInvoicePaymentSucceeded = async (
  client: PoolClient,
  event: Stripe.InvoicePaymentSucceededEvent,
) => {
  const invoice = event.data.object;
  const stripeSubscriptionId =
    getSubscriptionIdFromInvoice(invoice);

  if (!stripeSubscriptionId) {
    return;
  }

  const subscription =
    await stripe.subscriptions.retrieve(stripeSubscriptionId);

  const synced = await upsertStripeSubscription(
    client,
    subscription,
  );

  if (invoice.amount_paid <= 0) {
    return;
  }

  const paymentResult =
    await stripe.invoicePayments.list({
      invoice: invoice.id,
      status: "paid",
      limit: 10,
    });

  const invoicePayment =
    paymentResult.data.find((payment) => payment.is_default) ??
    paymentResult.data[0];

  const providerPaymentId =
    invoicePayment?.payment.payment_intent
      ? getStripeId(invoicePayment.payment.payment_intent)
      : invoicePayment?.id ?? invoice.id;

  const paidAt =
    invoicePayment?.status_transitions.paid_at
      ? unixToDate(invoicePayment.status_transitions.paid_at)
      : new Date(event.created * 1000);

  await client.query(
    `
      INSERT INTO subscription_payments (
        subscription_id,
        user_id,
        provider,
        amount,
        currency,
        paid_at,
        access_from,
        access_until,
        reference,
        notes,
        provider_payment_id,
        provider_event_id
      )
      VALUES (
        $1, $2, 'STRIPE', $3, $4, $5,
        $6, $7, $8, $9, $10, $11
      )
      ON CONFLICT DO NOTHING
    `,
    [
      synced.subscriptionId,
      synced.userId,
      invoice.amount_paid,
      invoice.currency.toUpperCase(),
      paidAt,
      synced.period.start,
      synced.period.end,
      invoice.id,
      `Stripe invoice ${invoice.id}`,
      providerPaymentId,
      event.id,
    ],
  );
};

const handleSubscriptionChanged = async (
  client: PoolClient,
  subscription: Stripe.Subscription,
) => {
  await upsertStripeSubscription(client, subscription);
};

const handleSubscriptionDeleted = async (
  client: PoolClient,
  subscription: Stripe.Subscription,
) => {
  await client.query(
    `
      UPDATE subscriptions
      SET
        status = 'CANCELED',
        cancel_at_period_end = FALSE,
        canceled_at = COALESCE(
          $1,
          canceled_at,
          NOW()
        ),
        ended_at = COALESCE(
          $2,
          ended_at,
          NOW()
        )
      WHERE provider = 'STRIPE'
        AND provider_subscription_id = $3
    `,
    [
      subscription.canceled_at
        ? unixToDate(subscription.canceled_at)
        : null,
      subscription.ended_at
        ? unixToDate(subscription.ended_at)
        : null,
      subscription.id,
    ],
  );
};

const handleInvoicePaymentFailed = async (
  client: PoolClient,
  event: Stripe.InvoicePaymentFailedEvent,
) => {
  const invoice = event.data.object;
  const stripeSubscriptionId =
    getSubscriptionIdFromInvoice(invoice);

  if (!stripeSubscriptionId) {
    return;
  }

  const subscription =
    await stripe.subscriptions.retrieve(stripeSubscriptionId);

  await upsertStripeSubscription(
    client,
    subscription,
  );
};

export const processStripeEvent = async (
  event: Stripe.Event,
) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const eventInsert = await client.query(
      `
        INSERT INTO payment_provider_events (
          provider,
          provider_event_id,
          event_type
        )
        VALUES ('STRIPE', $1, $2)
        ON CONFLICT (provider, provider_event_id)
        DO NOTHING
        RETURNING id
      `,
      [event.id, event.type],
    );

    if (eventInsert.rowCount === 0) {
      await client.query("ROLLBACK");

      return {
        duplicate: true,
      };
    }

    switch (event.type) {
      case "invoice.payment_succeeded":
        await handleInvoicePaymentSucceeded(client, event);
        break;

      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(client, event);
        break;

      case "customer.subscription.created":
      case "customer.subscription.updated":
        await handleSubscriptionChanged(
          client,
          event.data.object,
        );
        break;

      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(
          client,
          event.data.object,
        );
        break;

      default:
        break;
    }

    await client.query("COMMIT");

    return {
      duplicate: false,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};
