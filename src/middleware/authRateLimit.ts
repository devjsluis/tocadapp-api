import { rateLimit } from "express-rate-limit";
import type { Request } from "express";
import { createHash } from "crypto";

const normalizeEmail = (req: Request): string => {
  const email = req.body?.email;

  if (typeof email !== "string" || !email.trim()) {
    return "missing-email";
  }

  return email.trim().toLowerCase();
};

const resetTokenKey = (req: Request): string => {
  const token = req.body?.token;

  if (typeof token !== "string" || !token.trim()) {
    return "missing-token";
  }

  // Nunca usamos ni almacenamos el token crudo como key del limiter.
  return createHash("sha256").update(token.trim()).digest("hex");
};

export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: normalizeEmail,
  message: {
    error:
      "Demasiados intentos de inicio de sesión. Intenta nuevamente en unos minutos.",
    code: "RATE_LIMITED",
  },
});

export const emailActionRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: normalizeEmail,
  message: {
    error:
      "Has realizado demasiadas solicitudes. Intenta nuevamente más tarde.",
    code: "RATE_LIMITED",
  },
});

export const resetPasswordRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: resetTokenKey,
  message: {
    error:
      "Demasiados intentos para restablecer la contraseña. Intenta nuevamente más tarde.",
    code: "RATE_LIMITED",
  },
});
