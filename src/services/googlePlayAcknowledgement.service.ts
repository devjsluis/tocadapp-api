import {
  androidPublisher, GOOGLE_PLAY_PACKAGE_NAME, GOOGLE_PLAY_PRODUCT_ID,
} from "../lib/googlePlay";
import { getGooglePlaySubscription } from "./googlePlaySubscription.service";

type Purchase = Awaited<ReturnType<typeof getGooglePlaySubscription>>;
const anchors = (token: string, purchase: Purchase) => [...new Set([
  token, purchase.linkedPurchaseToken,
  purchase.outOfAppPurchaseContext?.expiredPurchaseToken,
].filter((value): value is string => Boolean(value)))].sort();

// Shares the subscription writer's token-lock order. Holding these locks through
// Google's call prevents a concurrent replacement/claim from overtaking the ack.
// No subscription/entitlement writes are performed by this worker.
export const acknowledgeSavedGooglePlayPurchase = async (
  purchaseToken: string, expectedUserId?: number,
): Promise<boolean> => {
  const { pool } = await import("../lib/db");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const initial = await getGooglePlaySubscription(purchaseToken);
    const tokens = anchors(purchaseToken, initial);
    for (const token of tokens) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [token]);
    }
    const purchase = await getGooglePlaySubscription(purchaseToken);
    if (JSON.stringify(tokens) !== JSON.stringify(anchors(purchaseToken, purchase))) {
      throw new Error("GOOGLE_PLAY_PURCHASE_LINK_CHANGED");
    }
    const ownership = await client.query<{
      purchase_token: string; user_id: number; replaced_by_token: string | null;
    }>(`SELECT purchase_token, user_id, replaced_by_token
        FROM google_play_purchase_tokens WHERE purchase_token = ANY($1::text[])
        ORDER BY purchase_token FOR UPDATE`, [tokens]);
    const jobs = await client.query<{ user_id: number; status: string }>(
      `SELECT user_id, status FROM google_play_acknowledgements
       WHERE purchase_token = $1 FOR UPDATE`, [purchaseToken],
    );
    const job = jobs.rows[0];
    if (!job || job.status === "COMPLETED" || job.status === "SKIPPED") {
      await client.query("COMMIT");
      return job?.status === "COMPLETED";
    }
    const finish = async (status: string, reason: string | null) => {
      await client.query(
        `UPDATE google_play_acknowledgements
         SET status = $2, reason = $3, attempts = attempts + 1, last_attempt_at = NOW(),
             completed_at = CASE WHEN $2 = 'COMPLETED' THEN NOW() ELSE NULL END
         WHERE purchase_token = $1`, [purchaseToken, status, reason],
      );
      await client.query("COMMIT");
      return status === "COMPLETED";
    };
    const current = ownership.rows.find(row => row.purchase_token === purchaseToken);
    if ((expectedUserId !== undefined && expectedUserId !== job.user_id) ||
        !current || ownership.rows.length !== tokens.length ||
        ownership.rows.some(row => row.user_id !== job.user_id) ||
        ownership.rows.some(row => row.purchase_token !== purchaseToken &&
          row.replaced_by_token && row.replaced_by_token !== purchaseToken)) {
      return await finish("DEFERRED", "OWNER_CONFLICT_OR_UNKNOWN");
    }
    if (current.replaced_by_token) return await finish("SKIPPED", "REPLACED_PURCHASE");
    const user = await client.query(
      "SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL LIMIT 1", [job.user_id],
    );
    const saved = await client.query<{ user_id: number }>(
      `SELECT id, user_id FROM subscriptions WHERE provider = 'GOOGLE_PLAY'
       AND provider_subscription_id = $1 LIMIT 1`, [purchaseToken],
    );
    if (!user.rowCount || saved.rows[0]?.user_id !== job.user_id) {
      return await finish("DEFERRED", "SAVED_PURCHASE_OWNER_MISMATCH");
    }
    if (purchase.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED") {
      return await finish("COMPLETED", null);
    }
    const expiry = new Date(purchase.lineItems![0]!.expiryTime ?? "").getTime();
    if (!["SUBSCRIPTION_STATE_ACTIVE", "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
          "SUBSCRIPTION_STATE_CANCELED"].includes(purchase.subscriptionState!) ||
        !Number.isFinite(expiry) || expiry <= Date.now() ||
        purchase.acknowledgementState !== "ACKNOWLEDGEMENT_STATE_PENDING") {
      return await finish("DEFERRED", "PURCHASE_NOT_ELIGIBLE");
    }
    await androidPublisher.purchases.subscriptions.acknowledge({
      packageName: GOOGLE_PLAY_PACKAGE_NAME, subscriptionId: GOOGLE_PLAY_PRODUCT_ID,
      token: purchaseToken, requestBody: {},
    });
    return await finish("COMPLETED", null);
  } catch (error) {
    await client.query("ROLLBACK");
    // Separate from the rolled-back attempt. Never overwrite a newer success.
    await client.query(`UPDATE google_play_acknowledgements
      SET status = 'RETRY', reason = 'ACKNOWLEDGEMENT_FAILED',
          attempts = attempts + 1, last_attempt_at = NOW()
      WHERE purchase_token = $1 AND status IN ('PENDING', 'RETRY', 'DEFERRED')`, [purchaseToken]);
    throw error;
  } finally {
    client.release();
  }
};

export const reconcileGooglePlayAcknowledgements = async (limit = 100) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("GOOGLE_PLAY_INVALID_RECONCILIATION_LIMIT");
  }
  const { query } = await import("../lib/db");
  // Also discovers purchases saved by an older backend during rollout. Repeated
  // discovery never resets a completed job, changes ownership, or grants access.
  // Lock parent ownership rows before inserting child jobs, in token order, to
  // avoid an FK/unique-key deadlock with a writer enqueueing the same token.
  await query(`INSERT INTO google_play_acknowledgements (purchase_token, user_id)
    SELECT t.purchase_token, t.user_id FROM google_play_purchase_tokens t
    WHERE EXISTS (SELECT 1 FROM subscriptions s WHERE s.provider = 'GOOGLE_PLAY'
      AND s.provider_subscription_id = t.purchase_token AND s.user_id = t.user_id)
    ORDER BY t.purchase_token FOR KEY SHARE OF t
    ON CONFLICT (purchase_token) DO NOTHING`);
  const pending = await query<{ purchase_token: string }>(
    `SELECT purchase_token FROM google_play_acknowledgements
     WHERE status IN ('PENDING', 'RETRY', 'DEFERRED')
     ORDER BY last_attempt_at ASC NULLS FIRST, purchase_token LIMIT $1`, [limit],
  );
  const summary = { completed: 0, deferred: 0, failed: 0 };
  for (const row of pending.rows) {
    try {
      if (await acknowledgeSavedGooglePlayPurchase(row.purchase_token)) summary.completed++;
      else summary.deferred++;
    } catch {
      summary.failed++;
    }
  }
  return summary;
};
