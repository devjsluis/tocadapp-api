import { GoogleAuth } from "google-auth-library";
import { androidpublisher } from "googleapis/build/src/apis/androidpublisher";

export const GOOGLE_PLAY_PACKAGE_NAME = "com.tocadapp.mobile";
const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/androidpublisher"],
});

export const androidPublisher = androidpublisher({
  version: "v3",
  auth,
});
