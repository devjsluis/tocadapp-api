import { GoogleAuth } from "google-auth-library";
import { androidpublisher } from "googleapis/build/src/apis/androidpublisher";

export const GOOGLE_PLAY_PACKAGE_NAME = "com.tocadapp.mobile";
export const GOOGLE_PLAY_PRODUCT_ID = "tocadapp_premium";

export const GOOGLE_PLAY_BASE_PLAN_TO_PLAN_CODE = {
  monthly: "TOCADAPP_MONTHLY",
  yearly: "TOCADAPP_YEARLY",
} as const;

export type GooglePlayBasePlanId =
  keyof typeof GOOGLE_PLAY_BASE_PLAN_TO_PLAN_CODE;

export type GooglePlayPlanCode =
  (typeof GOOGLE_PLAY_BASE_PLAN_TO_PLAN_CODE)[GooglePlayBasePlanId];

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/androidpublisher"],
});

export const androidPublisher = androidpublisher({
  version: "v3",
  auth,
});
