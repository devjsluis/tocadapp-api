import { recoverGooglePlayPurchase } from "./googlePlayRecovery.service";
import { googlePlayOwnershipErrors, resolveGooglePlayOwner } from "./googlePlayOwnership.service";
import { GOOGLE_PLAY_PACKAGE_NAME } from "../lib/googlePlay";
import {
  findGooglePlaySubscriptionOwner,
  getGooglePlaySubscription,
  syncGooglePlaySubscription,
} from "./googlePlaySubscription.service";

type GooglePlayDeveloperNotification = {
  version?: string;
  packageName?: string;
  eventTimeMillis?: string;
  subscriptionNotification?: {
    version?: string;
    notificationType?: number;
    purchaseToken?: string;
    subscriptionId?: string;
  };
  testNotification?: {
    version?: string;
  };
};

export type GooglePlayRtdnResult =
  | {
      kind: "TEST";
    }
  | {
      kind: "SUBSCRIPTION";
      notificationType: number;
      purchaseToken: string;
      userId: number;
    }
  | {
      kind: "IGNORED";
      reason: "UNSUPPORTED_NOTIFICATION";
    }
  | { kind: "CANCELED" }
  | { kind: "DEFERRED"; reason: string };

const decodeDeveloperNotification = (
  encodedData: string,
): GooglePlayDeveloperNotification => {
  const normalized = encodedData.trim();

  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    throw new Error("GOOGLE_PLAY_RTDN_INVALID_BASE64");
  }

  const decoded = Buffer.from(normalized, "base64").toString("utf8");

  try {
    return JSON.parse(decoded) as GooglePlayDeveloperNotification;
  } catch {
    throw new Error("GOOGLE_PLAY_RTDN_INVALID_JSON");
  }
};

export const processGooglePlayRtdn = async (
  encodedData: string,
): Promise<GooglePlayRtdnResult> => {
  if (typeof encodedData !== "string" || encodedData.trim().length === 0) {
    throw new Error("GOOGLE_PLAY_RTDN_DATA_REQUIRED");
  }

  const notification = decodeDeveloperNotification(encodedData);

  if (notification.packageName !== GOOGLE_PLAY_PACKAGE_NAME) {
    throw new Error("GOOGLE_PLAY_RTDN_INVALID_PACKAGE");
  }

  if (notification.testNotification) {
    return {
      kind: "TEST",
    };
  }

  const subscriptionNotification =
    notification.subscriptionNotification;

  if (!subscriptionNotification) {
    return {
      kind: "IGNORED",
      reason: "UNSUPPORTED_NOTIFICATION",
    };
  }

  const purchaseToken =
    subscriptionNotification.purchaseToken?.trim();
  const notificationType =
    subscriptionNotification.notificationType;

  if (!purchaseToken) {
    throw new Error("GOOGLE_PLAY_RTDN_PURCHASE_TOKEN_REQUIRED");
  }

  if (
    typeof notificationType !== "number" ||
    !Number.isInteger(notificationType)
  ) {
    throw new Error("GOOGLE_PLAY_RTDN_NOTIFICATION_TYPE_REQUIRED");
  }

  const { query } = await import("../lib/db");
  // Persist before Google or entitlement work. A 200 for DEFERRED means the
  // purchase is durably retained, never that it was assigned or acknowledged.
  await query(
    `INSERT INTO google_play_rtdn_purchases (purchase_token, notification_type)
     VALUES ($1, $2)
     ON CONFLICT (purchase_token) DO UPDATE
     SET notification_type = EXCLUDED.notification_type,
         received_at = NOW(), status = 'RECEIVED', version = google_play_rtdn_purchases.version + 1`,
    [purchaseToken, notificationType],
  );
  return processPersistedPurchase(purchaseToken, notificationType);
};

const processPersistedPurchase = async (
  purchaseToken: string,
  notificationType: number,
): Promise<GooglePlayRtdnResult> => {
  const { query } = await import("../lib/db");
  const attempt = await query<{ version: string }>(
    `UPDATE google_play_rtdn_purchases
     SET version = version + 1, attempts = attempts + 1, last_attempt_at = NOW()
     WHERE purchase_token = $1 RETURNING version`,
    [purchaseToken],
  );
  const version = attempt.rows[0]!.version;
  let snapshot: Awaited<ReturnType<typeof getGooglePlaySubscription>> | null = null;
  const finish = async (status: string, reason: string | null, userId: number | null = null) => {
    // An older attempt cannot overwrite a newer receipt/attempt's result.
    await query(
      `UPDATE google_play_rtdn_purchases
       SET status = $3, reason = $4, google_snapshot = $5::jsonb, user_id = $6
       WHERE purchase_token = $1 AND version = $2`,
      [purchaseToken, version, status, reason, snapshot ? JSON.stringify(snapshot) : null, userId],
    );
  };
  const defer = async (reason: string) => {
    await finish("DEFERRED", reason);
    return { kind: "DEFERRED" as const, reason };
  };

  try {
    snapshot = await getGooglePlaySubscription(purchaseToken);
    const anchors = [...new Set([
      purchaseToken,
      snapshot.linkedPurchaseToken,
      snapshot.outOfAppPurchaseContext?.expiredPurchaseToken,
    ].filter((token): token is string => Boolean(token)))];
    const owners = await Promise.all(anchors.map(findGooglePlaySubscriptionOwner));
    const knownOwners = [...new Set(owners.filter((owner): owner is number => owner !== null))];
    if (knownOwners.length > 1) return await defer("OWNER_CONFLICT");
    const userId = await resolveGooglePlayOwner(snapshot,
      owners.flatMap((owner, index) => owner === null ? [] : [{ purchase_token: anchors[index]!, user_id: owner }]),
      { query });
    if (userId === null) {
      if (snapshot.subscriptionState === "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED") {
        await recoverGooglePlayPurchase(purchaseToken);
        await finish("PROCESSED", null);
        return { kind: "CANCELED" };
      }
      return await defer("OWNER_UNKNOWN");
    }
    const result = await syncGooglePlaySubscription({ userId, purchaseToken });
    if (result.purchaseResult.state === "PENDING") return await defer("PENDING_PURCHASE");
    await finish("PROCESSED", null, userId);
    return { kind: "SUBSCRIPTION", notificationType, purchaseToken, userId };
  } catch (error) {
    const code = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    if (googlePlayOwnershipErrors.has(code)) {
      return await defer(code);
    }
    await finish("RETRY", "PROCESSING_FAILED");
    throw error; // Controller returns 500, preserving Pub/Sub retries.
  }
};

// Explicit reconciliation entry point: always fetch Google again, never replay
// a stored entitlement snapshot. Failures remain persisted for a later batch.
export const reconcilePendingGooglePlayRtdn = async (limit = 100) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("GOOGLE_PLAY_INVALID_RECONCILIATION_LIMIT");
  }
  const { query } = await import("../lib/db");
  const pending = await query<{ purchase_token: string; notification_type: number }>(
    `SELECT purchase_token, notification_type FROM google_play_rtdn_purchases
     WHERE status <> 'PROCESSED'
     ORDER BY last_attempt_at ASC NULLS FIRST, purchase_token LIMIT $1`,
    [limit],
  );
  const summary = { processed: 0, deferred: 0, failed: 0 };
  for (const row of pending.rows) {
    try {
      const result = await processPersistedPurchase(row.purchase_token, row.notification_type);
      if (result.kind === "SUBSCRIPTION" || result.kind === "CANCELED") summary.processed++;
      else summary.deferred++;
    } catch {
      summary.failed++;
    }
  }
  return summary;
};
