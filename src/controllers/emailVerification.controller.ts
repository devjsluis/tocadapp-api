import type { Request, Response } from "express";

import {
  resendVerificationEmail,
  verifyEmailToken,
} from "../services/emailVerification.service";

const RESEND_SUCCESS_MESSAGE =
  "Si el correo está registrado y pendiente de verificación, recibirás un enlace.";

export const verifyEmail = async (req: Request, res: Response) => {
  const { token } = req.body;

  if (typeof token !== "string" || !token.trim()) {
    return res.status(400).json({
      error: "El token de verificación es obligatorio",
      code: "VERIFICATION_TOKEN_REQUIRED",
    });
  }

  try {
    await verifyEmailToken(token.trim());

    return res.json({
      message: "Correo confirmado correctamente",
    });
  } catch (error) {
    if (!(error instanceof Error)) {
      return res.status(500).json({
        error: "No fue posible confirmar el correo",
      });
    }

    switch (error.message) {
      case "VERIFICATION_TOKEN_INVALID":
        return res.status(400).json({
          error: "El enlace de verificación no es válido",
          code: "VERIFICATION_TOKEN_INVALID",
        });

      case "VERIFICATION_TOKEN_USED":
        return res.status(400).json({
          error: "Este enlace ya fue utilizado",
          code: "VERIFICATION_TOKEN_USED",
        });

      case "VERIFICATION_TOKEN_EXPIRED":
        return res.status(400).json({
          error: "El enlace ha expirado. Solicita uno nuevo",
          code: "VERIFICATION_TOKEN_EXPIRED",
        });

      default:
        console.error("Error verificando correo:", error);

        return res.status(500).json({
          error: "No fue posible confirmar el correo",
        });
    }
  }
};

export const resendEmailVerification = async (req: Request, res: Response) => {
  const { email } = req.body;

  if (typeof email !== "string" || !email.trim()) {
    return res.status(400).json({
      error: "El correo es obligatorio",
    });
  }

  try {
    await resendVerificationEmail(email);

    return res.json({
      message: RESEND_SUCCESS_MESSAGE,
    });
  } catch (error) {
    console.error("Error reenviando verificación de correo:", error);

    return res.status(500).json({
      error: "No fue posible enviar el correo de verificación",
    });
  }
};
