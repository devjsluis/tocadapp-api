import { Request, Response } from "express";
import { processGooglePlayRtdn } from "../services/googlePlayRtdn.service";
import { verifyGooglePlayPubSubToken } from "../lib/googlePlayPubSubAuth";

type PubSubPushBody = {
  message?: {
    data?: string;
    messageId?: string;
    publishTime?: string;
  };
  subscription?: string;
};

export const handleGooglePlayWebhook = async (
  req: Request,
  res: Response,
) => {
  try {
    await verifyGooglePlayPubSubToken(req.headers.authorization);
  } catch (error) {
    const code =
      error instanceof Error ? error.message : "UNKNOWN_ERROR";

    if (code === "GOOGLE_PLAY_PUBSUB_AUTH_NOT_CONFIGURED") {
      console.error("Google Play Pub/Sub auth no está configurado");

      return res.status(503).json({
        error: "Webhook de Google Play no configurado",
        code: "GOOGLE_PLAY_PUBSUB_AUTH_NOT_CONFIGURED",
      });
    }

    console.warn(
      "[Google Play RTDN] Intento no autorizado:",
      code,
    );

    return res.status(401).json({
      error: "Notificación de Google Play no autorizada",
      code: "GOOGLE_PLAY_PUBSUB_UNAUTHORIZED",
    });
  }

  const body = req.body as PubSubPushBody;
  const messageId = body?.message?.messageId;
  const encodedData = body?.message?.data;

  if (!messageId || !encodedData) {
    return res.status(400).json({
      error: "Mensaje de Pub/Sub inválido",
      code: "INVALID_PUBSUB_MESSAGE",
    });
  }

  try {
    const result = await processGooglePlayRtdn(encodedData);

    console.log(
      `[Google Play RTDN] ${messageId} - ${result.kind}`,
    );

    return res.status(200).json({
      received: true,
      kind: result.kind,
    });
  } catch (error) {
    console.error(
      `[Google Play RTDN] Error procesando ${messageId}:`,
      error instanceof Error ? error.message : "UNKNOWN_ERROR",
    );

    return res.status(500).json({
      error: "No fue posible procesar la notificación de Google Play",
      code: "GOOGLE_PLAY_RTDN_PROCESSING_FAILED",
    });
  }
};
