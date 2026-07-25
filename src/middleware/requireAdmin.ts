import type { NextFunction, Request, Response } from "express";

const ALLOWED_ADMIN_ROLES = ["admin", "leader"];

export const requireAdmin = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const role = req.user?.role;

  if (!role) {
    return res.status(401).json({
      error: "No autorizado",
    });
  }

  if (!ALLOWED_ADMIN_ROLES.includes(role)) {
    return res.status(403).json({
      error: "No tienes permisos para administrar suscripciones",
      code: "ADMIN_REQUIRED",
    });
  }

  return next();
};
