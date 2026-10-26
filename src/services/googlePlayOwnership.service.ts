import type { androidpublisher_v3 } from "googleapis/build/src/apis/androidpublisher";

import { findGooglePlayBillingIdentityOwner, type BillingIdentityReader } from "./googlePlayIdentity.service";

type OwnershipRow = { purchase_token: string; user_id: number; replaced_by_token?: string | null };

// Inputs must come from subscriptionsv2.get, never from the verify request body.
// Every known anchor and every supplied Google identity must agree. Missing
// identities are allowed only when a durable token/chain owner already exists.
export async function resolveGooglePlayOwner(
  purchase: androidpublisher_v3.Schema$SubscriptionPurchaseV2,
  owners: OwnershipRow[],
  db: BillingIdentityReader,
): Promise<number | null> {
  const candidates = new Set(owners.map(row => row.user_id));
  const identities = [
    purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId,
    purchase.outOfAppPurchaseContext?.expiredExternalAccountIdentifiers?.obfuscatedExternalAccountId,
  ].filter((value): value is string => value != null);
  for (const identity of new Set(identities)) {
    const owner = await findGooglePlayBillingIdentityOwner(identity, db);
    if (owner === null) throw new Error("GOOGLE_PLAY_BILLING_IDENTITY_UNKNOWN");
    candidates.add(owner);
  }
  if (candidates.size > 1) throw new Error("GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED");
  return candidates.values().next().value ?? null;
}

export const googlePlayOwnershipErrors = new Set([
  "GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED",
  "GOOGLE_PLAY_BILLING_IDENTITY_UNKNOWN",
  "GOOGLE_PLAY_OWNER_UNVERIFIABLE",
  "GOOGLE_PLAY_LINKED_PURCHASE_OWNER_UNKNOWN",
  "USER_NOT_FOUND",
]);

// Never retain raw transport error messages (which may contain URLs/tokens).
export function googlePlayRecoveryErrorCode(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return /^(GOOGLE_PLAY_[A-Z_]+|PLAN_NOT_FOUND|USER_NOT_FOUND)$/.test(code)
    ? code : "GOOGLE_PLAY_VERIFICATION_FAILED";
}

// Conservative provisional policy: both Google-supplied predecessor kinds must
// be known, owned by the same account, and not already consumed by another
// successor. Call only with ownership rows read under the ordered token locks.
export function assertGooglePlayChainOwnership(
  purchaseToken: string,
  purchase: androidpublisher_v3.Schema$SubscriptionPurchaseV2,
  owners: OwnershipRow[],
  userId: number,
): void {
  if (owners.some(row => row.user_id !== userId)) {
    throw new Error("GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED");
  }
  const anchors = new Set([
    purchase.linkedPurchaseToken,
    purchase.outOfAppPurchaseContext?.expiredPurchaseToken,
  ].filter((token): token is string => Boolean(token)));
  for (const token of anchors) {
    const anchor = owners.find(row => row.purchase_token === token);
    if (!anchor) throw new Error("GOOGLE_PLAY_LINKED_PURCHASE_OWNER_UNKNOWN");
    if (token !== purchaseToken && anchor.replaced_by_token &&
        anchor.replaced_by_token !== purchaseToken) {
      throw new Error("GOOGLE_PLAY_PURCHASE_ALREADY_CLAIMED");
    }
  }
}
