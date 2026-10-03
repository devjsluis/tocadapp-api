import { OAuth2Client } from "google-auth-library";

const authClient = new OAuth2Client();

export const verifyGooglePlayPubSubToken = async (
  authorizationHeader: string | undefined,
) => {
  const audience = process.env.GOOGLE_PLAY_PUBSUB_AUDIENCE;
  const expectedEmail =
    process.env.GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT_EMAIL;

  if (!audience || !expectedEmail) {
    throw new Error("GOOGLE_PLAY_PUBSUB_AUTH_NOT_CONFIGURED");
  }

  if (
    !authorizationHeader ||
    !authorizationHeader.startsWith("Bearer ")
  ) {
    throw new Error("GOOGLE_PLAY_PUBSUB_TOKEN_MISSING");
  }

  const token = authorizationHeader.slice("Bearer ".length).trim();

  if (!token) {
    throw new Error("GOOGLE_PLAY_PUBSUB_TOKEN_MISSING");
  }

  const ticket = await authClient.verifyIdToken({
    idToken: token,
    audience,
  });

  const payload = ticket.getPayload();

  if (
    !payload ||
    payload.email !== expectedEmail ||
    payload.email_verified !== true
  ) {
    throw new Error("GOOGLE_PLAY_PUBSUB_TOKEN_INVALID");
  }

  return {
    email: payload.email,
    subject: payload.sub,
  };
};
