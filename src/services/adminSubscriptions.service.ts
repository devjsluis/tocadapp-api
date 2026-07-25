import { pool } from "../lib/db";

type UpdateSubscriptionPaymentInput = {
  paymentId: number;
  amount: number;
  currency?: string;
  paidAt: string;
  accessFrom: string;
  accessUntil: string;
  reference?: string | null;
  notes?: string | null;
};

type PaymentPeriodRow = {
  id: number;
  subscription_id: number;
  user_id: number;
  access_from: Date;
  access_until: Date;
};

type GrantManualAccessInput = {
  userId: number;
  planCode: string;
  amount: number;
  currency?: string;
  months?: number;
  accessUntil?: string;
  paymentReference?: string | null;
  notes?: string | null;
  registeredByUserId: number;
};

type SubscriptionRow = {
  id: number;
  user_id: number;
  plan_id: number;
  status: string;
  provider: string;
  price_amount: number;
  currency: string;
  started_at: Date;
  current_period_start: Date;
  current_period_end: Date;
  cancel_at_period_end: boolean;
  canceled_at: Date | null;
  ended_at: Date | null;
};

const addUtcMonths = (date: Date, months: number): Date => {
  const result = new Date(date);

  const originalDay = result.getUTCDate();

  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);

  const lastDayOfTargetMonth = new Date(
    Date.UTC(
      result.getUTCFullYear(),
      result.getUTCMonth() + 1,
      0,
      result.getUTCHours(),
      result.getUTCMinutes(),
      result.getUTCSeconds(),
      result.getUTCMilliseconds(),
    ),
  ).getUTCDate();

  result.setUTCDate(Math.min(originalDay, lastDayOfTargetMonth));

  return result;
};

const synchronizeSubscriptionFromPayments = async (
  client: {
    query: (
      text: string,
      params?: unknown[],
    ) => Promise<{
      rows: PaymentPeriodRow[];
      rowCount: number | null;
    }>;
  },
  subscriptionId: number,
) => {
  const latestPaymentResult = await client.query(
    `
      SELECT
        id,
        subscription_id,
        user_id,
        access_from,
        access_until
      FROM subscription_payments
      WHERE subscription_id = $1
      ORDER BY access_until DESC, id DESC
      LIMIT 1
    `,
    [subscriptionId],
  );

  const latestPayment = latestPaymentResult.rows[0];

  if (!latestPayment) {
    await client.query(
      `
        UPDATE subscriptions
        SET
          status = 'EXPIRED',
          current_period_end = NOW(),
          ended_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
      `,
      [subscriptionId],
    );

    return;
  }

  const now = new Date();
  const accessUntil = new Date(latestPayment.access_until);
  const isActive = accessUntil > now;

  await client.query(
    `
      UPDATE subscriptions
      SET
        status = $1,
        current_period_start = $2,
        current_period_end = $3,
        ended_at = $4,
        updated_at = NOW()
      WHERE id = $5
    `,
    [
      isActive ? "ACTIVE" : "EXPIRED",
      latestPayment.access_from,
      latestPayment.access_until,
      isActive ? null : now.toISOString(),
      subscriptionId,
    ],
  );
};

export const updateSubscriptionPayment = async ({
  paymentId,
  amount,
  currency = "MXN",
  paidAt,
  accessFrom,
  accessUntil,
  reference = null,
  notes = null,
}: UpdateSubscriptionPaymentInput) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (!Number.isInteger(amount) || amount < 0) {
      throw new Error("INVALID_AMOUNT");
    }

    const normalizedCurrency = currency.trim().toUpperCase();

    if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
      throw new Error("INVALID_CURRENCY");
    }

    const parsedPaidAt = new Date(paidAt);
    const parsedAccessFrom = new Date(accessFrom);
    const parsedAccessUntil = new Date(accessUntil);

    if (Number.isNaN(parsedPaidAt.getTime())) {
      throw new Error("INVALID_PAID_AT");
    }

    if (
      Number.isNaN(parsedAccessFrom.getTime()) ||
      Number.isNaN(parsedAccessUntil.getTime())
    ) {
      throw new Error("INVALID_ACCESS_PERIOD");
    }

    if (parsedAccessUntil < parsedAccessFrom) {
      throw new Error("ACCESS_UNTIL_BEFORE_ACCESS_FROM");
    }

    const paymentResult = await client.query(
      `
        UPDATE subscription_payments
        SET
          amount = $1,
          currency = $2,
          paid_at = $3,
          access_from = $4,
          access_until = $5,
          reference = $6,
          notes = $7
        WHERE id = $8
        RETURNING *
      `,
      [
        amount,
        normalizedCurrency,
        parsedPaidAt.toISOString(),
        parsedAccessFrom.toISOString(),
        parsedAccessUntil.toISOString(),
        reference,
        notes,
        paymentId,
      ],
    );

    if (paymentResult.rowCount === 0) {
      throw new Error("PAYMENT_NOT_FOUND");
    }

    const payment = paymentResult.rows[0];

    await synchronizeSubscriptionFromPayments(client, payment.subscription_id);

    await client.query("COMMIT");

    return payment;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const deleteSubscriptionPayment = async (paymentId: number) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const paymentResult = await client.query(
      `
        DELETE FROM subscription_payments
        WHERE id = $1
        RETURNING *
      `,
      [paymentId],
    );

    if (paymentResult.rowCount === 0) {
      throw new Error("PAYMENT_NOT_FOUND");
    }

    const payment = paymentResult.rows[0];

    await synchronizeSubscriptionFromPayments(client, payment.subscription_id);

    await client.query("COMMIT");

    return payment;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const grantManualAccess = async ({
  userId,
  planCode,
  amount,
  currency = "MXN",
  months,
  accessUntil,
  paymentReference = null,
  notes = null,
  registeredByUserId,
}: GrantManualAccessInput) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const userResult = await client.query(
      `
        SELECT id, email, name
        FROM users
        WHERE id = $1
        LIMIT 1
      `,
      [userId],
    );

    if (userResult.rowCount === 0) {
      throw new Error("USER_NOT_FOUND");
    }

    const planResult = await client.query(
      `
        SELECT
          id,
          code,
          name,
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

    if (!Number.isInteger(amount) || amount < 0) {
      throw new Error("INVALID_AMOUNT");
    }

    const normalizedCurrency = currency.trim().toUpperCase();

    if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
      throw new Error("INVALID_CURRENCY");
    }

    const existingSubscriptionResult = await client.query<SubscriptionRow>(
      `
          SELECT *
          FROM subscriptions
          WHERE user_id = $1
          ORDER BY id DESC
          LIMIT 1
          FOR UPDATE
        `,
      [userId],
    );

    const currentSubscription = existingSubscriptionResult.rows[0] ?? null;

    const now = new Date();

    let accessFrom: Date;
    let calculatedAccessUntil: Date;
    let subscriptionStatus: "ACTIVE" | "EXPIRED";

    if (accessUntil) {
      calculatedAccessUntil = new Date(accessUntil);

      if (Number.isNaN(calculatedAccessUntil.getTime())) {
        throw new Error("INVALID_ACCESS_UNTIL");
      }

      if (calculatedAccessUntil <= now) {
        accessFrom = new Date(calculatedAccessUntil);
        accessFrom.setMinutes(accessFrom.getMinutes() - 1);
      } else {
        accessFrom = now;
      }
    } else {
      if (
        months === undefined ||
        !Number.isInteger(months) ||
        months <= 0 ||
        months > 120
      ) {
        throw new Error("INVALID_MONTHS");
      }

      const currentPeriodEnd = currentSubscription?.current_period_end
        ? new Date(currentSubscription.current_period_end)
        : null;

      accessFrom =
        currentPeriodEnd &&
        !Number.isNaN(currentPeriodEnd.getTime()) &&
        currentPeriodEnd > now
          ? currentPeriodEnd
          : now;

      calculatedAccessUntil = addUtcMonths(accessFrom, months);
    }

    subscriptionStatus = calculatedAccessUntil > now ? "ACTIVE" : "EXPIRED";

    const plan = planResult.rows[0];

    console.log({
      accessFrom: accessFrom.toISOString(),
      accessUntil: calculatedAccessUntil.toISOString(),
      subscriptionStatus,
    });

    let subscription: SubscriptionRow;

    if (!currentSubscription) {
      const subscriptionResult = await client.query<SubscriptionRow>(
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
              $1,
              $2,
              $3,
              'MANUAL',
              NULL,
              NULL,
              $4,
              $5,
              NOW(),
              $6,
              $7,
              FALSE,
              NULL,
              CASE
                WHEN $3::varchar = 'EXPIRED'::varchar THEN NOW()
                ELSE NULL
              END
            )
            RETURNING *
          `,
        [
          userId,
          plan.id,
          subscriptionStatus,
          plan.price_amount,
          plan.currency,
          accessFrom.toISOString(),
          calculatedAccessUntil.toISOString(),
        ],
      );

      subscription = subscriptionResult.rows[0];
    } else {
      const subscriptionResult = await client.query<SubscriptionRow>(
        `
            UPDATE subscriptions
            SET
              plan_id = $2,
              status = $1,
              provider = 'MANUAL',
              provider_customer_id = NULL,
              provider_subscription_id = NULL,
              price_amount = $3,
              currency = $4,
              current_period_start = $5,
              current_period_end = $6,
              cancel_at_period_end = FALSE,
              canceled_at = NULL,
              ended_at = CASE
                WHEN $1::varchar = 'EXPIRED'::varchar THEN NOW()
                ELSE NULL
              END,
              updated_at = NOW()
            WHERE id = $7
            RETURNING *
          `,
        [
          subscriptionStatus,
          plan.id,
          plan.price_amount,
          plan.currency,
          accessFrom.toISOString(),
          calculatedAccessUntil.toISOString(),
          currentSubscription.id,
        ],
      );

      subscription = subscriptionResult.rows[0];
    }

    const paymentResult = await client.query(
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
          registered_by_user_id
        )
        VALUES (
          $1,
          $2,
          'MANUAL',
          $3,
          $4,
          NOW(),
          $5,
          $6,
          $7,
          $8,
          $9
        )
        RETURNING *
      `,
      [
        subscription.id,
        userId,
        amount,
        normalizedCurrency,
        accessFrom.toISOString(),
        calculatedAccessUntil.toISOString(),
        paymentReference,
        notes,
        registeredByUserId,
      ],
    );

    await client.query("COMMIT");

    return {
      user: userResult.rows[0],
      plan,
      subscription,
      payment: paymentResult.rows[0],
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const getAdminSubscriptions = async () => {
  const result = await pool.query(
    `
      SELECT
        u.id AS user_id,
        u.name,
        u.email,

        s.id AS subscription_id,
        s.status,
        s.provider,
        s.price_amount,
        s.currency,
        s.current_period_start,
        s.current_period_end,
        s.cancel_at_period_end,

        p.id AS plan_id,
        p.code AS plan_code,
        p.name AS plan_name,

        CASE
          WHEN s.status = 'ACTIVE'
            AND s.current_period_end > NOW()
          THEN TRUE
          ELSE FALSE
        END AS has_access

      FROM users u

      LEFT JOIN LATERAL (
        SELECT subscriptions.*
        FROM subscriptions
        WHERE subscriptions.user_id = u.id
        ORDER BY subscriptions.id DESC
        LIMIT 1
      ) s ON TRUE

      LEFT JOIN plans p
        ON p.id = s.plan_id

      ORDER BY
        has_access DESC,
        s.current_period_end DESC NULLS LAST,
        u.name ASC,
        u.email ASC
    `,
  );

  return result.rows;
};

export const getSubscriptionPaymentsByUserId = async (userId: number) => {
  const userResult = await pool.query(
    `
      SELECT id, name, email
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [userId],
  );

  if (userResult.rowCount === 0) {
    throw new Error("USER_NOT_FOUND");
  }

  const paymentsResult = await pool.query(
    `
      SELECT
        sp.id,
        sp.subscription_id,
        sp.provider,
        sp.amount,
        sp.currency,
        sp.paid_at,
        sp.access_from,
        sp.access_until,
        sp.reference,
        sp.notes,
        sp.registered_by_user_id,
        administrator.name AS registered_by_name,
        administrator.email AS registered_by_email,
        p.code AS plan_code,
        p.name AS plan_name

      FROM subscription_payments sp

      JOIN subscriptions s
        ON s.id = sp.subscription_id

      JOIN plans p
        ON p.id = s.plan_id

      LEFT JOIN users administrator
        ON administrator.id = sp.registered_by_user_id

      WHERE sp.user_id = $1

      ORDER BY sp.paid_at DESC, sp.id DESC
    `,
    [userId],
  );

  return {
    user: userResult.rows[0],
    payments: paymentsResult.rows,
  };
};
