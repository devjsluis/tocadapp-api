import { readFileSync } from "node:fs";
import { AppStoreServerAPIClient, Environment, SignedDataVerifier } from "@apple/app-store-server-library";

export const APPLE_PRODUCTS = {
  "com.tocadapp.mobile.premium.monthly": "TOCADAPP_MONTHLY",
  "com.tocadapp.mobile.premium.yearly": "TOCADAPP_YEARLY",
} as const;

export function appleEnvironment(userId?: number) {
  if (process.env.APPLE_ENVIRONMENT === "Sandbox") return Environment.SANDBOX;
  if (process.env.APPLE_ENVIRONMENT === "Production") {
    const reviewers = (process.env.APPLE_SANDBOX_USER_IDS ?? "").split(",").map(id => id.trim());
    return userId !== undefined && reviewers.includes(String(userId)) ? Environment.SANDBOX : Environment.PRODUCTION;
  }
  throw new Error("APPLE_NOT_CONFIGURED");
}

const cached = new Map<Environment, { client: AppStoreServerAPIClient; verifier: SignedDataVerifier }>();
export function appleStore(environment = appleEnvironment()) {
  if (environment !== Environment.SANDBOX && environment !== Environment.PRODUCTION) throw new Error("APPLE_NOT_CONFIGURED");
  if (appleEnvironment() === Environment.SANDBOX && environment !== Environment.SANDBOX) throw new Error("INVALID_APPLE_PURCHASE");
  const existing = cached.get(environment);
  if (existing) return existing;
  const { APPLE_KEY_ID: keyId, APPLE_ISSUER_ID: issuerId, APPLE_PRIVATE_KEY_PATH: keyPath,
    APPLE_ROOT_CA_PATHS: rootPaths, APPLE_APP_ID: appId } = process.env;
  if (!keyId || !issuerId || !keyPath || !rootPaths ||
      (environment === Environment.PRODUCTION && (!appId || !/^\d+$/.test(appId)))) {
    throw new Error("APPLE_NOT_CONFIGURED");
  }
  const bundleId = "com.tocadapp.mobile";
  const store = {
    client: new AppStoreServerAPIClient(readFileSync(keyPath, "utf8"), keyId, issuerId, bundleId, environment),
    verifier: new SignedDataVerifier(rootPaths.split(",").map(path => readFileSync(path.trim())),
      true, environment, bundleId, appId ? Number(appId) : undefined),
  };
  cached.set(environment, store);
  return store;
}
