// Google is authoritative for the product/plan associated with a token.
export const GOOGLE_PLAY_NEW_PRODUCT_ID = "tocadapp_premium_v2";
export const GOOGLE_PLAY_LEGACY_PRODUCT_ID = "tocadapp_premium";
const plans = { monthly: "TOCADAPP_MONTHLY", yearly: "TOCADAPP_YEARLY" } as const;
const catalog = {
  [GOOGLE_PLAY_LEGACY_PRODUCT_ID]: plans,
  [GOOGLE_PLAY_NEW_PRODUCT_ID]: plans,
} as const;
export type GooglePlayProductId = keyof typeof catalog;
export type GooglePlayBasePlanId = keyof typeof plans;
export type GooglePlayPlanCode = (typeof plans)[GooglePlayBasePlanId];

export function getGooglePlayPlan(productId: string | null | undefined, basePlanId: string | null | undefined): { productId: GooglePlayProductId; basePlanId: GooglePlayBasePlanId; planCode: GooglePlayPlanCode } {
  if (!productId || !Object.prototype.hasOwnProperty.call(catalog, productId)) {
    throw new Error("GOOGLE_PLAY_INVALID_PRODUCT");
  }
  const product = productId as GooglePlayProductId;
  if (!basePlanId || !Object.prototype.hasOwnProperty.call(catalog[product], basePlanId)) {
    throw new Error("GOOGLE_PLAY_INVALID_BASE_PLAN");
  }
  const basePlan = basePlanId as GooglePlayBasePlanId;
  return { productId: product, basePlanId: basePlan, planCode: catalog[product][basePlan] };
}

// Only the exact operator opt-in enables new sales. Recovery never uses this flag.
export function getGooglePlayPurchasePolicy(env: Record<string, string | undefined> = process.env) {
  return {
    newPurchasesEnabled: env.GOOGLE_PLAY_NEW_PURCHASES_ENABLED === "true",
    productId: GOOGLE_PLAY_NEW_PRODUCT_ID,
    basePlans: { TOCADAPP_MONTHLY: "monthly", TOCADAPP_YEARLY: "yearly" },
  };
}
