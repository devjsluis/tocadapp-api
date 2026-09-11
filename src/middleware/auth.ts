import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

import { pool } from "../lib/db";
import { JWT_SECRET } from "../lib/authConfig";

export interface AuthRequest extends Request {
  user?: { id: number; email: string; role: string };
}


export async function authMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "No autorizado" });
    return;
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as {
      id: number;
      email: string;
      role: string;
      type?: string;
      sessionVersion?: number;
    };

    if (decoded.type !== "access") {
      res.status(401).json({ error: "Token inválido" });
      return;
    }

    const result = await pool.query(
      `
        SELECT id, email, role, session_version
        FROM users
        WHERE id = $1
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [decoded.id],
    );

    if (result.rowCount === 0) {
      res.status(401).json({
        error: "La cuenta ya no está disponible",
        code: "ACCOUNT_DELETED",
      });
      return;
    }

    const user = result.rows[0];

    if (decoded.sessionVersion !== user.session_version) {
      res.status(401).json({
        error: "La sesión ya no es válida",
        code: "SESSION_REVOKED",
      });
      return;
    }

    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
    };

    next();
  } catch {
    res.status(401).json({ error: "Token inválido o expirado" });
  }
}
