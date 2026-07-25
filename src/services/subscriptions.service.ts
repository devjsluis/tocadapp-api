import { pool } from "../lib/db";

export type SubscriptionStatus =
  | "PENDING"
  | "ACTIVE"
  | "PAST_DUE"
  | "CANCELED"
  | "EXPIRED";

export interface UserSubscription {
  id: number;
  status: SubscriptionStatus;
  provider: string;
  priceAmount: number;
  currency: string;
  startedAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  endedAt: Date | null;
  plan: {
    id: number;
    code: string;
    name: string;
    billingInterval: string;
    intervalCount: number;
  };
}

interface SubscriptionRow {
  id: string;
  status: SubscriptionStatus;
  provider: string;
  price_amount: number;
  currency: string;
  started_at: Date | null;
  current_period_start: Date | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  canceled_at: Date | null;
  ended_at: Date | null;
  plan_id: string;
  plan_code: string;
  plan_name: string;
  billing_interval: string;
  interval_count: number;
}

const mapSubscription = (row: SubscriptionRow): UserSubscription => ({
  id: Number(row.id),
  status: row.status,
  provider: row.provider,
  priceAmount: row.price_amount,
  currency: row.currency,
  startedAt: row.started_at,
  currentPeriodStart: row.current_period_start,
  currentPeriodEnd: row.current_period_end,
  cancelAtPeriodEnd: row.cancel_at_period_end,
  canceledAt: row.canceled_at,
  endedAt: row.ended_at,
  plan: {
    id: Number(row.plan_id),
    code: row.plan_code,
    name: row.plan_name,
    billingInterval: row.billing_interval,
    intervalCount: row.interval_count,
  },
});

export const getCurrentSubscriptionByUserId = async (
  userId: number,
): Promise<UserSubscription | null> => {
  const result = await pool.query<SubscriptionRow>(
    `
      SELECT
        s.id,
        s.status,
        s.provider,
        s.price_amount,
        s.currency,
        s.started_at,
        s.current_period_start,
        s.current_period_end,
        s.cancel_at_period_end,
        s.canceled_at,
        s.ended_at,
        p.id AS plan_id,
        p.code AS plan_code,
        p.name AS plan_name,
        p.billing_interval,
        p.interval_count
      FROM subscriptions s
      INNER JOIN plans p ON p.id = s.plan_id
      WHERE s.user_id = $1
      ORDER BY
        CASE
          WHEN s.status IN ('PENDING', 'ACTIVE', 'PAST_DUE') THEN 0
          ELSE 1
        END,
        s.created_at DESC
      LIMIT 1
    `,
    [userId],
  );

  if (result.rowCount === 0) {
    return null;
  }

  return mapSubscription(result.rows[0]);
};

export const subscriptionGrantsAccess = (
  subscription: UserSubscription | null,
): boolean => {
  if (!subscription || subscription.status !== "ACTIVE") {
    return false;
  }

  if (!subscription.currentPeriodEnd) {
    return false;
  }

  return subscription.currentPeriodEnd.getTime() > Date.now();
};
