import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

import { pool } from "../lib/db";

export interface AuthRequest extends Request {
  user?: { id: number; email: string; role: string };
}

const JWT_SECRET = process.env.JWT_SECRET || "TU_SECRETO_SUPER_SECRETO";

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
    };

    if (decoded.type && decoded.type !== "access") {
      res.status(401).json({ error: "Token inválido" });
      return;
    }

    const result = await pool.query(
      `
        SELECT id, email, role
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
