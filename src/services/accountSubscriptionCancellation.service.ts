import { pool } from "../lib/db";
import { stripe } from "../lib/stripe";

type StripeSubscriptionRow = {
  provider_subscription_id: string;
};

export const cancelExternalSubscriptionsForAccountDeletion = async (
  userId: number,
) => {
  const result = await pool.query<StripeSubscriptionRow>(
    `
      SELECT provider_subscription_id
      FROM subscriptions
      WHERE user_id = $1
        AND provider = 'STRIPE'
        AND provider_subscription_id IS NOT NULL
        AND status IN ('PENDING', 'ACTIVE', 'PAST_DUE')
    `,
    [userId],
  );

  for (const row of result.rows) {
    try {
      await stripe.subscriptions.cancel(row.provider_subscription_id);
    } catch (error: any) {
      // Si Stripe ya no encuentra la suscripción, localmente podemos
      // considerarla terminada igualmente.
      if (error?.code === "resource_missing") {
        continue;
      }

      throw error;
    }
  }
};
