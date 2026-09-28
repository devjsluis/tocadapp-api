import { pool } from "../lib/db";
import { stripe } from "../lib/stripe";

type StripeSubscriptionRow = {
  provider_subscription_id: string | null;
};

const getStripeSubscriptionForUser = async (
  userId: number,
): Promise<string> => {
  const result = await pool.query<StripeSubscriptionRow>(
    `
      SELECT provider_subscription_id
      FROM subscriptions
      WHERE user_id = $1
        AND provider = 'STRIPE'
        AND status IN ('ACTIVE', 'PAST_DUE')
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [userId],
  );

  if (result.rowCount === 0) {
    throw new Error("STRIPE_SUBSCRIPTION_NOT_FOUND");
  }

  const subscriptionId = result.rows[0].provider_subscription_id;

  if (!subscriptionId) {
    throw new Error("STRIPE_SUBSCRIPTION_ID_MISSING");
  }

  return subscriptionId;
};

const updateLocalCancelAtPeriodEnd = async (
  userId: number,
  providerSubscriptionId: string,
  cancelAtPeriodEnd: boolean,
) => {
  await pool.query(
    `
      UPDATE subscriptions
      SET
        cancel_at_period_end = $1,
        updated_at = NOW()
      WHERE user_id = $2
        AND provider = 'STRIPE'
        AND provider_subscription_id = $3
    `,
    [cancelAtPeriodEnd, userId, providerSubscriptionId],
  );
};

export const cancelStripeSubscriptionAtPeriodEnd = async (
  userId: number,
) => {
  const subscriptionId = await getStripeSubscriptionForUser(userId);

  const subscription = await stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: true,
  });

  await updateLocalCancelAtPeriodEnd(
    userId,
    subscription.id,
    subscription.cancel_at_period_end,
  );

  return {
    providerSubscriptionId: subscription.id,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  };
};

export const reactivateStripeSubscription = async (
  userId: number,
) => {
  const subscriptionId = await getStripeSubscriptionForUser(userId);

  const subscription = await stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: false,
  });

  await updateLocalCancelAtPeriodEnd(
    userId,
    subscription.id,
    subscription.cancel_at_period_end,
  );

  return {
    providerSubscriptionId: subscription.id,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  };
};
