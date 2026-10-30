import { randomUUID } from "node:crypto";
import { Environment, type JWSTransactionDecodedPayload, type JWSRenewalInfoDecodedPayload } from "@apple/app-store-server-library";
import { pool } from "../lib/db";
import { appleEnvironment, appleStore, APPLE_PRODUCTS } from "../lib/apple";
import { getCurrentSubscriptionByUserId, subscriptionGrantsAccess } from "./subscriptions.service";

export function validateAppleTransaction(tx: JWSTransactionDecodedPayload, environment = appleEnvironment()) {
  if (tx.bundleId !== "com.tocadapp.mobile" || tx.environment !== environment ||
      tx.type !== "Auto-Renewable Subscription" || tx.inAppOwnershipType !== "PURCHASED" ||
      !tx.productId || !Object.prototype.hasOwnProperty.call(APPLE_PRODUCTS, tx.productId) || !tx.transactionId || !tx.originalTransactionId ||
      !tx.appAccountToken || !Number.isFinite(tx.purchaseDate) || !Number.isFinite(tx.expiresDate) ||
      tx.expiresDate! <= tx.purchaseDate!) throw new Error("INVALID_APPLE_PURCHASE");
  return APPLE_PRODUCTS[tx.productId as keyof typeof APPLE_PRODUCTS];
}

export function appleEntitlement(tx: JWSTransactionDecodedPayload, renewal: JWSRenewalInfoDecodedPayload, status: number, now = Date.now()) {
  // A canceled renewal keeps paid access until expiry; billing retry alone does not.
  const end = status === 4 && Number.isFinite(renewal.gracePeriodExpiresDate)
    ? Math.max(tx.expiresDate!, renewal.gracePeriodExpiresDate!) : tx.expiresDate!;
  const active = !tx.revocationDate && !tx.isUpgraded && [1, 4].includes(status) && end > now;
  return { status: active ? "ACTIVE" : "EXPIRED", end: new Date(end), cancelAtPeriodEnd: renewal.autoRenewStatus !== 1 };
}

export async function getAppleBillingIdentity(userId: number) {
  appleStore(appleEnvironment(userId)); // Fail closed until keys and trusted Apple roots are configured.
  await pool.query(`INSERT INTO apple_billing_identities (user_id, app_account_token)
    SELECT id, $2::uuid FROM users WHERE id = $1 AND deleted_at IS NULL
    ON CONFLICT (user_id) DO NOTHING`, [userId, randomUUID()]);
  const identity = await pool.query<{ app_account_token: string }>(
    "SELECT app_account_token FROM apple_billing_identities WHERE user_id = $1", [userId]);
  if (!identity.rows[0]) throw new Error("APPLE_ACCOUNT_UNAVAILABLE");
  const current = await getCurrentSubscriptionByUserId(userId);
  return { contractVersion: 1, appAccountToken: identity.rows[0].app_account_token,
    environment: appleEnvironment(userId), products: APPLE_PRODUCTS,
    newPurchasesEnabled: process.env.APPLE_NEW_PURCHASES_ENABLED === "true" && !subscriptionGrantsAccess(current) };
}

export async function syncAppleSubscription(transactionId: string, expectedUserId?: number, notificationEnvironment?: Environment) {
  const environment = notificationEnvironment ?? appleEnvironment(expectedUserId);
  const { client: apple, verifier } = appleStore(environment);
  const db = await pool.connect();
  try {
    // Verify the submitted ID with Apple, never trust client-decoded JWS or account IDs.
    const info = await apple.getTransactionInfo(transactionId);
    if (!info.signedTransactionInfo) throw new Error("INVALID_APPLE_PURCHASE");
    const submitted = await verifier.verifyAndDecodeTransaction(info.signedTransactionInfo);
    validateAppleTransaction(submitted, environment);
    if (submitted.transactionId !== transactionId) throw new Error("INVALID_APPLE_PURCHASE");
    const original = submitted.originalTransactionId!;
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`apple:${environment}:${original}`]);

    // Fetch current status under the chain lock. Delayed/duplicate notifications cannot replay old entitlement dates.
    const response = await apple.getAllSubscriptionStatuses(original);
    const candidates = (response.data ?? []).flatMap(group => group.lastTransactions ?? [])
      .filter(item => item.originalTransactionId === original);
    if (candidates.length !== 1 || !candidates[0].signedTransactionInfo || !candidates[0].signedRenewalInfo ||
        ![1, 2, 3, 4, 5].includes(candidates[0].status!)) throw new Error("APPLE_STATUS_UNAVAILABLE");
    const latest = candidates[0];
    const tx = await verifier.verifyAndDecodeTransaction(latest.signedTransactionInfo!);
    const renewal = await verifier.verifyAndDecodeRenewalInfo(latest.signedRenewalInfo!);
    const planCode = validateAppleTransaction(tx, environment);
    if (tx.originalTransactionId !== original || renewal.originalTransactionId !== original ||
        tx.appAccountToken!.toLowerCase() !== submitted.appAccountToken!.toLowerCase()) throw new Error("INVALID_APPLE_PURCHASE");

    const owner = await db.query<{ user_id: number }>(`SELECT i.user_id FROM apple_billing_identities i
      JOIN users u ON u.id = i.user_id WHERE app_account_token = $1::uuid AND u.deleted_at IS NULL`, [tx.appAccountToken]);
    const userId = owner.rows[0]?.user_id;
    if (!userId || (expectedUserId !== undefined && userId !== expectedUserId)) throw new Error("APPLE_PURCHASE_ACCOUNT_CONFLICT");
    if (appleEnvironment(userId) !== environment) throw new Error("APPLE_PURCHASE_ACCOUNT_CONFLICT");
    const chain = await db.query<{ user_id: number }>(`SELECT user_id FROM apple_subscription_chains
      WHERE environment = $1 AND original_transaction_id = $2 FOR UPDATE`, [environment, original]);
    if (chain.rows[0] && chain.rows[0].user_id !== userId) throw new Error("APPLE_PURCHASE_ACCOUNT_CONFLICT");
    const account = await db.query<{ deleted_at: Date | null }>(
      "SELECT id, deleted_at FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (!account.rows[0] || account.rows[0].deleted_at) throw new Error("APPLE_PURCHASE_ACCOUNT_CONFLICT");
    const entitlement = appleEntitlement(tx, renewal, latest.status!);
    const providerId = `${environment}:${original}`;
    const plan = await db.query<{ id: string; price_amount: number; currency: string }>(
      "SELECT id, price_amount, currency FROM plans WHERE code = $1 AND active = TRUE", [planCode]);
    if (!plan.rows[0]) throw new Error("PLAN_NOT_FOUND");
    const existing = await db.query<{ id: string; user_id: number }>(`SELECT id, user_id FROM subscriptions
      WHERE provider = 'APPLE' AND provider_subscription_id = $1 FOR UPDATE`, [providerId]);
    if (existing.rows[0] && existing.rows[0].user_id !== userId) throw new Error("APPLE_PURCHASE_ACCOUNT_CONFLICT");
    const open = await db.query<{ id: string; provider: string; current_period_end: Date | null }>(`SELECT id, provider, current_period_end FROM subscriptions
      WHERE user_id = $1 AND status IN ('PENDING','ACTIVE','PAST_DUE')
      AND NOT (provider = 'APPLE' AND provider_subscription_id = $2) FOR UPDATE`, [userId, providerId]);
    if (entitlement.status === "ACTIVE" && open.rows.some(row => !['TRIAL', 'MANUAL'].includes(row.provider) &&
        (!row.current_period_end || row.current_period_end.getTime() > Date.now()))) throw new Error("APPLE_OTHER_SUBSCRIPTION_ACTIVE");
    if (entitlement.status === "ACTIVE") {
      await db.query(`UPDATE subscriptions SET status = 'EXPIRED', ended_at = GREATEST(started_at, NOW())
        WHERE user_id = $1 AND status IN ('PENDING','ACTIVE','PAST_DUE')
        AND NOT (provider = 'APPLE' AND provider_subscription_id = $2)`, [userId, providerId]);
    }
    // An inactive restore must never replace an unrelated open subscription.
    if (entitlement.status === "ACTIVE" || existing.rows[0] || open.rows.length === 0) {
      const price = tx.price != null && tx.currency ? Math.round(tx.price / 10) : plan.rows[0].price_amount;
      const currency = tx.price != null && tx.currency ? tx.currency : plan.rows[0].currency;
      await db.query(`INSERT INTO subscriptions (user_id, plan_id, provider, provider_subscription_id, status,
        price_amount, currency, started_at, current_period_start, current_period_end, cancel_at_period_end)
        VALUES ($1,$2,'APPLE',$3,$4,$5,$6,$7,$7,$8,$9)
        ON CONFLICT (provider, provider_subscription_id) WHERE provider_subscription_id IS NOT NULL
        DO UPDATE SET plan_id = EXCLUDED.plan_id, status = EXCLUDED.status, price_amount = EXCLUDED.price_amount,
        currency = EXCLUDED.currency, current_period_start = EXCLUDED.current_period_start,
        current_period_end = EXCLUDED.current_period_end, cancel_at_period_end = EXCLUDED.cancel_at_period_end,
        ended_at = CASE WHEN EXCLUDED.status = 'EXPIRED' THEN GREATEST(subscriptions.started_at, NOW()) ELSE NULL END`,
      [userId, plan.rows[0].id, providerId, entitlement.status, price, currency, new Date(tx.purchaseDate!), entitlement.end, entitlement.cancelAtPeriodEnd]);
    }
    await db.query(`INSERT INTO apple_subscription_chains (environment, original_transaction_id, user_id, transaction_id, product_id, status)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (environment, original_transaction_id)
      DO UPDATE SET transaction_id = EXCLUDED.transaction_id, product_id = EXCLUDED.product_id,
        status = EXCLUDED.status, verified_at = NOW()`, [environment, original, userId, tx.transactionId, tx.productId, latest.status]);
    await db.query("COMMIT");
    return { userId, purchaseResult: { state: entitlement.status === "ACTIVE" ? "ACTIVE" : "INACTIVE",
      transactionId, originalTransactionId: original, persisted: true, retryable: false } };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally { db.release(); }
}
