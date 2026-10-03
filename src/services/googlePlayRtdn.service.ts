import { GOOGLE_PLAY_PACKAGE_NAME } from "../lib/googlePlay";
import {
  findGooglePlaySubscriptionOwner,
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
      reason: "UNSUPPORTED_NOTIFICATION" | "UNKNOWN_PURCHASE_TOKEN";
    };

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

  const userId =
    await findGooglePlaySubscriptionOwner(purchaseToken);

  if (!userId) {
    return {
      kind: "IGNORED",
      reason: "UNKNOWN_PURCHASE_TOKEN",
    };
  }

  await syncGooglePlaySubscription({
    userId,
    purchaseToken,
  });

  return {
    kind: "SUBSCRIPTION",
    notificationType,
    purchaseToken,
    userId,
  };
};
