import { androidPublisher, GOOGLE_PLAY_PACKAGE_NAME } from "../lib/googlePlay";
import { getGooglePlayPlan, type GooglePlayProductId, type GooglePlayBasePlanId, type GooglePlayPlanCode } from "./googlePlayCatalog.service";

import { assertGooglePlayChainOwnership, googlePlayRecoveryErrorCode, resolveGooglePlayOwner, googlePlayOwnershipErrors } from "./googlePlayOwnership.service";
import { beginGooglePlayRecovery, finishGooglePlayRecovery } from "./googlePlayRecovery.service";

export type GooglePlayPurchaseResult = {
  state: "PENDING" | "CANCELED" | "ACTIVE" | "INACTIVE" | "REPLACED";
  subscriptionState: string;
  acknowledgementState: string | null;
  retryable: boolean;
};

export type VerifiedGooglePlaySubscription = {
  purchaseToken: string;
  productId: GooglePlayProductId;
  planCode: GooglePlayPlanCode;
  basePlanId: GooglePlayBasePlanId;
  subscriptionState: string;
  acknowledgementState: string | null;
  startTime: Date | null;
  expiryTime: Date | null;
  googleSnapshot: Awaited<ReturnType<typeof getGooglePlaySubscription>>;
  autoRenewEnabled: boolean;
  latestSuccessfulOrderId: string | null;
  linkedPurchaseToken: string | null;
  expiredPurchaseToken: string | null;
  isTestPurchase: boolean;
};

const parseGoogleDate = (
  value: string | null | undefined,
  errorCode: string,
): Date => {
  if (!value) {
    throw new Error(errorCode);
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(errorCode);
  }

  return date;
};

export const getGooglePlaySubscription = async (purchaseToken: string) => {
  const token = purchaseToken.trim();

  if (!token) {
    throw new Error("GOOGLE_PLAY_PURCHASE_TOKEN_REQUIRED");
  }

  const response =
    await androidPublisher.purchases.subscriptionsv2.get({
      packageName: GOOGLE_PLAY_PACKAGE_NAME,
      token,
    });

  const purchase = response.data;
  const lineItems = purchase.lineItems ?? [];

  if (lineItems.length !== 1) {
    throw new Error("GOOGLE_PLAY_UNEXPECTED_LINE_ITEMS");
  }

  const lineItem = lineItems[0];

  getGooglePlayPlan(lineItem.productId, lineItem.offerDetails?.basePlanId);

  const subscriptionState = purchase.subscriptionState;

  if (!subscriptionState) {
    throw new Error("GOOGLE_PLAY_SUBSCRIPTION_STATE_MISSING");
  }

  return purchase;
};

export const verifyGooglePlaySubscription = async (
  purchaseToken: string,
): Promise<VerifiedGooglePlaySubscription> => {
  const purchase = await getGooglePlaySubscription(purchaseToken);
  const lineItem = purchase.lineItems![0]!;
  const { productId, basePlanId, planCode } = getGooglePlayPlan(lineItem.productId, lineItem.offerDetails?.basePlanId);
  const subscriptionState = purchase.subscriptionState!;
  const awaitingPayment = subscriptionState === "SUBSCRIPTION_STATE_PENDING" ||
    subscriptionState === "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED";
  const startTime = awaitingPayment ? null : parseGoogleDate(
    purchase.startTime,
    "GOOGLE_PLAY_START_TIME_MISSING",
  );

  const expiryTime = awaitingPayment ? null : parseGoogleDate(
    lineItem.expiryTime,
    "GOOGLE_PLAY_EXPIRY_TIME_MISSING",
  );

  return {
    googleSnapshot: purchase,
    purchaseToken: purchaseToken.trim(),
    productId,
    planCode,
    basePlanId,
    subscriptionState,
    acknowledgementState: purchase.acknowledgementState ?? null,
    startTime,
    expiryTime,
    autoRenewEnabled:
      lineItem.autoRenewingPlan?.autoRenewEnabled === true,
    latestSuccessfulOrderId:
      lineItem.latestSuccessfulOrderId ?? null,
    linkedPurchaseToken: purchase.linkedPurchaseToken ?? null,
    expiredPurchaseToken: purchase.outOfAppPurchaseContext?.expiredPurchaseToken ?? null,
    isTestPurchase: purchase.testPurchase != null,
  };
};

type TocadAppSubscriptionStatus =
  | "PENDING"
  | "ACTIVE"
  | "PAST_DUE"
  | "CANCELED"
  | "EXPIRED";

type PlanRow = {
  id: string;
  price_amount: number;
  currency: string;
};

const mapGooglePlayStatus = (
  verified: VerifiedGooglePlaySubscription,
): TocadAppSubscriptionStatus => {
  const hasRemainingAccess = (verified.expiryTime?.getTime() ?? 0) > Date.now();

  switch (verified.subscriptionState) {
    case "SUBSCRIPTION_STATE_ACTIVE":
    case "SUBSCRIPTION_STATE_IN_GRACE_PERIOD":
      return hasRemainingAccess ? "ACTIVE" : "EXPIRED";

    case "SUBSCRIPTION_STATE_CANCELED":
      return hasRemainingAccess ? "ACTIVE" : "EXPIRED";

    case "SUBSCRIPTION_STATE_PENDING":
      return "PENDING";

    case "SUBSCRIPTION_STATE_ON_HOLD":
    case "SUBSCRIPTION_STATE_PAUSED":
      return "PAST_DUE";

    case "SUBSCRIPTION_STATE_EXPIRED":
    case "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED":
      return "EXPIRED";

    default:
      throw new Error("GOOGLE_PLAY_UNSUPPORTED_SUBSCRIPTION_STATE");
  }
};

const syncGooglePlaySubscriptionCore = async ({
  userId,
  purchaseToken,
}: {
  userId: number;
  purchaseToken: string;
}) => {
  let verified = await verifyGooglePlaySubscription(purchaseToken);

  const { pool } = await import("../lib/db");
  const client = await pool.connect();
  let transactionCommitted = false;
  let clientReleased = false;

  try {
    await client.query("BEGIN");

    // Serialize claims even when neither token has a subscription row yet.
    // Always lock in the same order, before locking the user, across accounts.
    const tokens = [...new Set([
      verified.purchaseToken,
      ...(verified.linkedPurchaseToken ? [verified.linkedPurchaseToken] : []),
      ...(verified.expiredPurchaseToken ? [verified.expiredPurchaseToken] : []),
    ])].sort();

    for (const token of tokens) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [token],
      );
    }

    // A second worker may have waited here with an older Google snapshot.
    // Re-read while serialized before changing entitlements.
    const current = await verifyGooglePlaySubscription(purchaseToken);
    if (
      current.productId !== verified.productId ||
      current.basePlanId !== verified.basePlanId ||
      current.linkedPurchaseToken !== verified.linkedPurchaseToken ||
      current.expiredPurchaseToken !== verified.expiredPurchaseToken
    ) {
      throw new Error("GOOGLE_PLAY_PURCHASE_LINK_CHANGED");
    }
    verified = current;

    const userResult = await client.query(
      `
        SELECT id
        FROM users
        WHERE id = $1
          AND deleted_at IS NULL
        LIMIT 1
        FOR UPDATE
      `,
      [userId],
    );

    if (userResult.rowCount === 0) {
      throw new Error("USER_NOT_FOUND");
    }

    const ownershipResult = await client.query<{
      purchase_token: string;
      user_id: number;
      replaced_by_token: string | null;
    }>(
      `
        SELECT purchase_token, user_id, replaced_by_token
        FROM google_play_purchase_tokens
        WHERE purchase_token = ANY($1::text[])
        ORDER BY purchase_token
        FOR UPDATE
      `,
      [tokens],
    );

    if (ownershipResult.rows.some((row) => row.user_id !== userId)) {
      throw new Error("GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED");
    }

    const verifiedOwner = await resolveGooglePlayOwner(verified.googleSnapshot, ownershipResult.rows, client);
    if (verifiedOwner === null) throw new Error("GOOGLE_PLAY_OWNER_UNVERIFIABLE");
    if (verifiedOwner !== userId) throw new Error("GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED");

    const currentOwnership = ownershipResult.rows.find(
      (row) => row.purchase_token === verified.purchaseToken,
    );

    // A superseded token is terminal locally, regardless of a stale Google
    // response. In particular, never expire its successor or acknowledge it.
    if (currentOwnership?.replaced_by_token) {
      await client.query("COMMIT");
      transactionCommitted = true;
      return {
        purchaseResult: purchaseResult(verified, "REPLACED"),
        subscriptionId: null,
        status: "EXPIRED" as const,
        planCode: verified.planCode,
        currentPeriodEnd: verified.expiryTime,
        cancelAtPeriodEnd: true,
        acknowledgementState: verified.acknowledgementState,
        isTestPurchase: verified.isTestPurchase,
      };
    }

    assertGooglePlayChainOwnership(
      verified.purchaseToken, verified.googleSnapshot, ownershipResult.rows, userId,
    );

    // Pending/canceled payments are work records, never entitlement rows.
    // Keep the old subscription and replacement chain intact in both states.
    if (verified.subscriptionState === "SUBSCRIPTION_STATE_PENDING" ||
        verified.subscriptionState === "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED") {
      await client.query(
        `INSERT INTO google_play_purchase_tokens (purchase_token, user_id)
         VALUES ($1, $2) ON CONFLICT (purchase_token) DO NOTHING`,
        [verified.purchaseToken, userId],
      );
      await client.query("COMMIT");
      transactionCommitted = true;
      const canceled = verified.subscriptionState === "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED";
      return {
        purchaseResult: purchaseResult(verified, canceled ? "CANCELED" : "PENDING"),
        subscriptionId: null, status: canceled ? "EXPIRED" as const : "PENDING" as const,
        planCode: verified.planCode, currentPeriodEnd: null,
        cancelAtPeriodEnd: false, acknowledgementState: verified.acknowledgementState,
        isTestPurchase: verified.isTestPurchase,
      };
    }
    if (!verified.startTime || !verified.expiryTime) throw new Error("GOOGLE_PLAY_PURCHASE_DATES_MISSING");

    const planResult = await client.query<PlanRow>(
      `
        SELECT id, price_amount, currency
        FROM plans
        WHERE code = $1
          AND active = TRUE
        LIMIT 1
      `,
      [verified.planCode],
    );

    if (planResult.rowCount === 0) {
      throw new Error("PLAN_NOT_FOUND");
    }

    const plan = planResult.rows[0];

    const existingTokenResult = await client.query<{
      id: string;
      user_id: number;
    }>(
      `
        SELECT id, user_id
        FROM subscriptions
        WHERE provider = 'GOOGLE_PLAY'
          AND provider_subscription_id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [verified.purchaseToken],
    );

    const existingTokenSubscription = existingTokenResult.rows[0];

    if (
      existingTokenSubscription &&
      existingTokenSubscription.user_id !== userId
    ) {
      throw new Error("GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED");
    }

    const status = mapGooglePlayStatus(verified);

    // Persist ownership of the current token; a linked predecessor must
    // already have an owner, checked above under the same token locks.
    for (const token of tokens) {
      await client.query(
        `
          INSERT INTO google_play_purchase_tokens (purchase_token, user_id)
          VALUES ($1, $2)
          ON CONFLICT (purchase_token) DO NOTHING
        `,
        [token, userId],
      );
    }

    const replacesPreviousPurchase =
      verified.linkedPurchaseToken &&
      verified.linkedPurchaseToken !== verified.purchaseToken &&
      verified.subscriptionState !== "SUBSCRIPTION_STATE_PENDING" &&
      verified.subscriptionState !== "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED";

    if (replacesPreviousPurchase) {
      await client.query(
        `
          UPDATE google_play_purchase_tokens
          SET replaced_by_token = $2
          WHERE purchase_token = $1 AND user_id = $3
        `,
        [verified.linkedPurchaseToken, verified.purchaseToken, userId],
      );
      await client.query(
        `
          UPDATE subscriptions
          SET status = 'EXPIRED',
              ended_at = COALESCE(ended_at, GREATEST(started_at, NOW())),
              cancel_at_period_end = FALSE
          WHERE provider = 'GOOGLE_PLAY'
            AND provider_subscription_id = $1
            AND user_id = $2
        `,
        [verified.linkedPurchaseToken, userId],
      );
    }

    const canceledAt =
      verified.subscriptionState === "SUBSCRIPTION_STATE_CANCELED"
        ? new Date()
        : null;

    const endedAt =
      status === "EXPIRED" ? verified.expiryTime : null;

    const cancelAtPeriodEnd =
      verified.subscriptionState === "SUBSCRIPTION_STATE_CANCELED" ||
      !verified.autoRenewEnabled;

    if (status === "ACTIVE") {
      await client.query(
        `
          UPDATE subscriptions
          SET
            status = 'EXPIRED',
            ended_at = COALESCE(ended_at, NOW()),
            cancel_at_period_end = FALSE
          WHERE user_id = $1
            AND status IN ('PENDING', 'ACTIVE', 'PAST_DUE')
            AND NOT (
              provider = 'GOOGLE_PLAY'
              AND provider_subscription_id = $2
            )
        `,
        [userId, verified.purchaseToken],
      );
    } else if (!existingTokenSubscription) {
      const openSubscriptionResult = await client.query(
        `
          SELECT id
          FROM subscriptions
          WHERE user_id = $1
            AND status IN ('PENDING', 'ACTIVE', 'PAST_DUE')
          LIMIT 1
        `,
        [userId],
      );

      if (openSubscriptionResult.rowCount !== 0) {
        await client.query("COMMIT");
        transactionCommitted = true;

        return {
          purchaseResult: purchaseResult(verified, "INACTIVE"),
          subscriptionId: null,
          status,
          planCode: verified.planCode,
          currentPeriodEnd: verified.expiryTime,
          cancelAtPeriodEnd,
          acknowledgementState: verified.acknowledgementState,
          isTestPurchase: verified.isTestPurchase,
        };
      }
    }

    let subscriptionId: number;

    if (existingTokenSubscription) {
      subscriptionId = Number(existingTokenSubscription.id);

      await client.query(
        `
          UPDATE subscriptions
          SET
            plan_id = $1,
            status = $2,
            price_amount = $3,
            currency = $4,
            started_at = COALESCE(started_at, $5),
            current_period_start = COALESCE(current_period_start, $5),
            current_period_end = $6,
            cancel_at_period_end = $7,
            canceled_at = CASE
              WHEN $8::timestamptz IS NOT NULL
                THEN COALESCE(canceled_at, $8::timestamptz)
              WHEN $9::timestamptz IS NOT NULL
                THEN canceled_at
              ELSE NULL
            END,
            ended_at = $9
          WHERE id = $10
        `,
        [
          plan.id,
          status,
          plan.price_amount,
          plan.currency,
          verified.startTime,
          verified.expiryTime,
          cancelAtPeriodEnd,
          canceledAt,
          endedAt,
          subscriptionId,
        ],
      );
    } else {
      const insertResult = await client.query<{ id: string }>(
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
            $1, $2, $3, 'GOOGLE_PLAY', NULL, $4, $5, $6,
            $7, $7, $8, $9, $10, $11
          )
          RETURNING id
        `,
        [
          userId,
          plan.id,
          status,
          verified.purchaseToken,
          plan.price_amount,
          plan.currency,
          verified.startTime,
          verified.expiryTime,
          cancelAtPeriodEnd,
          canceledAt,
          endedAt,
        ],
      );

      subscriptionId = Number(insertResult.rows[0].id);
    }

    const canAcknowledge =
      verified.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING" &&
      verified.expiryTime.getTime() > Date.now() &&
      ["SUBSCRIPTION_STATE_ACTIVE", "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
       "SUBSCRIPTION_STATE_CANCELED"].includes(verified.subscriptionState);

    if (canAcknowledge) {
      await client.query(
        `INSERT INTO google_play_acknowledgements (purchase_token, user_id)
         VALUES ($1, $2) ON CONFLICT (purchase_token) DO NOTHING`,
        [verified.purchaseToken, userId],
      );
    }
    await client.query("COMMIT");
    transactionCommitted = true;
    // The acknowledgement worker needs its own transaction/connection.
    client.release();
    clientReleased = true;

    let acknowledged = false;
    if (canAcknowledge) {
      const { acknowledgeSavedGooglePlayPurchase } = await import("./googlePlayAcknowledgement.service");
      acknowledged = await acknowledgeSavedGooglePlayPurchase(verified.purchaseToken, userId);
    }

    return {
      purchaseResult: purchaseResult(verified, status === "ACTIVE" ? "ACTIVE" : "INACTIVE", acknowledged),
      subscriptionId,
      status,
      planCode: verified.planCode,
      currentPeriodEnd: verified.expiryTime,
      cancelAtPeriodEnd,
      acknowledgementState: acknowledged
        ? "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED"
        : verified.acknowledgementState,
      isTestPurchase: verified.isTestPurchase,
    };
  } catch (error) {
    if (!transactionCommitted) {
      await client.query("ROLLBACK");
    }

    throw error;
  } finally {
    if (!clientReleased) client.release();
  }
};

function purchaseResult(
  verified: VerifiedGooglePlaySubscription, state: GooglePlayPurchaseResult["state"], acknowledged = false,
): GooglePlayPurchaseResult {
  return { state, subscriptionState: verified.subscriptionState,
    acknowledgementState: acknowledged ? "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" : verified.acknowledgementState,
    retryable: state === "PENDING" };
}

export const syncGooglePlaySubscription = async ({ userId, purchaseToken }: { userId: number; purchaseToken: string }) => {
  const token = purchaseToken.trim();
  if (!token) throw new Error("GOOGLE_PLAY_PURCHASE_TOKEN_REQUIRED");
  // Persist before Google; an HTTP timeout/process crash cannot lose this work.
  // user_id is populated only after Google + durable ownership checks succeed.
  const version = await beginGooglePlayRecovery(token);
  try {
    const result = await syncGooglePlaySubscriptionCore({ userId, purchaseToken: token });
    await finishGooglePlayRecovery(token, version,
      result.purchaseResult.state === "PENDING" ? "PENDING" : "PROCESSED", null,
      userId, result.purchaseResult.subscriptionState);
    return result;
  } catch (error) {
    const code = googlePlayRecoveryErrorCode(error);
    await finishGooglePlayRecovery(token, version,
      googlePlayOwnershipErrors.has(code) ? "DEFERRED" : "RETRY", code);
    throw error;
  }
};

export const findGooglePlaySubscriptionOwner = async (
  purchaseToken: string,
): Promise<number | null> => {
  const token = purchaseToken.trim();

  if (!token) {
    return null;
  }

  const { query } = await import("../lib/db");

  const result = await query<{ user_id: number }>(
    `
      SELECT user_id
      FROM google_play_purchase_tokens
      WHERE purchase_token = $1
      LIMIT 1
    `,
    [token],
  );

  return result.rows[0]?.user_id ?? null;
};
