import { query } from "../lib/db";
import { googlePlayRecoveryErrorCode, googlePlayOwnershipErrors, resolveGooglePlayOwner } from "./googlePlayOwnership.service";

export async function beginGooglePlayRecovery(purchaseToken: string): Promise<string> {
  const result = await query<{ version: string }>(
    `INSERT INTO google_play_purchase_recovery(purchase_token) VALUES ($1)
     ON CONFLICT (purchase_token) DO UPDATE SET
       version = google_play_purchase_recovery.version + 1,
       attempts = google_play_purchase_recovery.attempts + 1,
       status = 'RETRY', last_attempt_at = NOW()
     RETURNING version`, [purchaseToken],
  );
  return result.rows[0]!.version;
}

export async function finishGooglePlayRecovery(
  token: string, version: string, status: string, reason: string | null,
  userId: number | null = null, purchaseState: string | null = null,
) {
  await query(
    `UPDATE google_play_purchase_recovery SET status = $3, reason = $4,
       user_id = COALESCE($5, user_id), purchase_state = COALESCE($6, purchase_state)
     WHERE purchase_token = $1 AND version = $2`,
    [token, version, status, reason, userId, purchaseState],
  );
}

// Used without an authenticated requester. The ownership resolver and the writer
// both check Google; the writer rechecks after acquiring its transaction locks.
export async function recoverGooglePlayPurchase(purchaseToken: string) {
  const { getGooglePlaySubscription, syncGooglePlaySubscription } = await import("./googlePlaySubscription.service");
  const version = await beginGooglePlayRecovery(purchaseToken);
  try {
    const snapshot = await getGooglePlaySubscription(purchaseToken);
    const anchors = [...new Set([purchaseToken, snapshot.linkedPurchaseToken,
      snapshot.outOfAppPurchaseContext?.expiredPurchaseToken].filter((v): v is string => !!v))];
    const owners = await query<{ purchase_token: string; user_id: number }>(
      "SELECT purchase_token, user_id FROM google_play_purchase_tokens WHERE purchase_token = ANY($1::text[])", [anchors],
    );
    const owner = await resolveGooglePlayOwner(snapshot, owners.rows, { query });
    if (owner === null && snapshot.subscriptionState === "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED") {
      // Google confirms a terminal unpaid operation. Stop retrying without
      // creating ownership, a subscription or an acknowledgement obligation.
      await finishGooglePlayRecovery(purchaseToken, version, "PROCESSED", null, null, snapshot.subscriptionState);
      return { purchaseResult: { state: "CANCELED" as const, subscriptionState: snapshot.subscriptionState,
        acknowledgementState: snapshot.acknowledgementState ?? null, retryable: false } };
    }
    if (owner === null) throw new Error("GOOGLE_PLAY_OWNER_UNVERIFIABLE");
    return await syncGooglePlaySubscription({ userId: owner, purchaseToken });
  } catch (error) {
    const code = googlePlayRecoveryErrorCode(error);
    await finishGooglePlayRecovery(purchaseToken, version,
      googlePlayOwnershipErrors.has(code) ? "DEFERRED" : "RETRY", code);
    throw error;
  }
}

export async function reconcileGooglePlayPurchases(limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("GOOGLE_PLAY_INVALID_RECONCILIATION_LIMIT");
  const pending = await query<{ purchase_token: string }>(
    `SELECT purchase_token FROM google_play_purchase_recovery
     WHERE status <> 'PROCESSED' ORDER BY last_attempt_at, purchase_token LIMIT $1`, [limit],
  );
  const summary = { processed: 0, pending: 0, deferred: 0, failed: 0 };
  for (const row of pending.rows) {
    try {
      const result = await recoverGooglePlayPurchase(row.purchase_token);
      if (result.purchaseResult.state === "PENDING") summary.pending++;
      else summary.processed++;
    } catch (error) {
      if (error instanceof Error && googlePlayOwnershipErrors.has(error.message)) summary.deferred++;
      else summary.failed++;
    }
  }
  return summary;
}
