import { Response } from "express";
import { pool } from "../lib/db";
import { AuthRequest } from "../middleware/auth";

export const registerPushToken = async (
  req: AuthRequest,
  res: Response,
) => {
  const userId = req.user!.id;
  const { expo_push_token, platform } = req.body;

  if (
    typeof expo_push_token !== "string" ||
    !expo_push_token.trim()
  ) {
    return res.status(400).json({
      error: "Push token inválido",
    });
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO user_push_tokens (
        user_id,
        expo_push_token,
        platform
      )
      VALUES ($1, $2, $3)
      ON CONFLICT (expo_push_token)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        platform = EXCLUDED.platform,
        updated_at = NOW()
      RETURNING *
      `,
      [
        userId,
        expo_push_token.trim(),
        typeof platform === "string" ? platform : null,
      ],
    );

    return res.json({
      ok: true,
      data: result.rows[0],
    });
  } catch (error: any) {
    console.error("Error al registrar push token:", error);

    return res.status(500).json({
      error: error.message,
    });
  }
};

export const deletePushToken = async (
  req: AuthRequest,
  res: Response,
) => {
  const userId = req.user!.id;
  const { expo_push_token } = req.body;

  if (
    typeof expo_push_token !== "string" ||
    !expo_push_token.trim()
  ) {
    return res.status(400).json({
      error: "Push token inválido",
    });
  }

  try {
    await pool.query(
      `
      DELETE FROM user_push_tokens
      WHERE user_id = $1
        AND expo_push_token = $2
      `,
      [userId, expo_push_token.trim()],
    );

    return res.json({
      ok: true,
    });
  } catch (error: any) {
    console.error("Error al eliminar push token:", error);

    return res.status(500).json({
      error: error.message,
    });
  }
};
