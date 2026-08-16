import { Request, Response } from "express";
import { pool } from "../lib/db";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { randomBytes } from "crypto";
import axios from "axios";
import { AuthRequest } from "../middleware/auth";
import {
  createEmailVerificationToken,
  sendEmailVerification,
} from "../services/emailVerification.service";

export const createUser = async (req: Request, res: Response) => {
  const { email, name, lastName, password } = req.body;

  if (!email || !name || !lastName || !password) {
    return res.status(400).json({
      error:
        "Todos los campos (nombre, apellido, correo y contraseña) son obligatorios",
    });
  }

  if (typeof password !== "string" || password.length < 6) {
    return res.status(400).json({
      error: "La contraseña debe tener al menos 6 caracteres",
    });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const normalizedName = String(name).trim();
  const normalizedLastName = String(lastName).trim();

  if (!normalizedEmail || !normalizedName || !normalizedLastName) {
    return res.status(400).json({
      error: "Nombre, apellido y correo no pueden estar vacíos",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existingUser = await client.query(
      `
        SELECT id
        FROM users
        WHERE LOWER(email) = LOWER($1)
        LIMIT 1
      `,
      [normalizedEmail],
    );

    if ((existingUser.rowCount ?? 0) > 0) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "Este correo electrónico ya está registrado",
      });
    }

    const planResult = await client.query(
      `
        SELECT id, price_amount, currency
        FROM plans
        WHERE code = 'TOCADAPP_MONTHLY'
          AND active = TRUE
        LIMIT 1
      `,
    );

    if (planResult.rowCount === 0) {
      throw new Error("TRIAL_PLAN_NOT_FOUND");
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const userResult = await client.query(
      `
        INSERT INTO users (
          email,
          name,
          last_name,
          password,
          role,
          email_verified_at
        )
        VALUES ($1, $2, $3, $4, 'musician', NULL)
        RETURNING
          id,
          email,
          name,
          last_name,
          role,
          created_at
      `,
      [normalizedEmail, normalizedName, normalizedLastName, hashedPassword],
    );

    const user = userResult.rows[0];
    const verificationToken = await createEmailVerificationToken(
      client,
      user.id,
    );
    const plan = planResult.rows[0];

    const subscriptionResult = await client.query(
      `
        INSERT INTO subscriptions (
          user_id,
          plan_id,
          status,
          provider,
          price_amount,
          currency,
          started_at,
          current_period_start,
          current_period_end,
          cancel_at_period_end
        )
        VALUES (
          $1,
          $2,
          'ACTIVE',
          'TRIAL',
          $3,
          $4,
          NOW(),
          NOW(),
          NOW() + INTERVAL '7 days',
          FALSE
        )
        RETURNING
          id,
          status,
          provider,
          current_period_start,
          current_period_end
      `,
      [user.id, plan.id, plan.price_amount, plan.currency],
    );

    await client.query("COMMIT");

    let emailSent = false;

    try {
      await sendEmailVerification(user.email, user.name, verificationToken);

      emailSent = true;
    } catch (emailError) {
      console.error(
        "La cuenta se creó, pero no se envió la verificación:",
        emailError,
      );
    }

    return res.status(201).json({
      user,
      subscription: subscriptionResult.rows[0],
      requiresEmailVerification: true,
      emailSent,
      message: emailSent
        ? "Cuenta creada. Revisa tu correo para confirmar tu dirección."
        : "Cuenta creada, pero no fue posible enviar el correo de verificación.",
    });
  } catch (error: unknown) {
    await client.query("ROLLBACK");

    console.error("Error al crear usuario:", error);

    if (error instanceof Error && error.message === "TRIAL_PLAN_NOT_FOUND") {
      return res.status(500).json({
        error: "No se encontró el plan necesario para iniciar la prueba",
      });
    }

    const databaseError = error as { code?: string };

    if (databaseError.code === "23505") {
      return res.status(400).json({
        error: "Este correo electrónico ya está registrado",
      });
    }

    return res.status(500).json({
      error: "Error interno del servidor",
    });
  } finally {
    client.release();
  }
};

export const loginUser = async (req: Request, res: Response) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [
      email,
    ]);

    if (result.rowCount === 0) {
      return res.status(401).json({ error: "El correo electrónico no existe" });
    }

    const user = result.rows[0];

    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      return res.status(401).json({
        error: "Contraseña incorrecta",
      });
    }

    if (!user.email_verified_at) {
      return res.status(403).json({
        error: "Debes confirmar tu correo antes de iniciar sesión",
        code: "EMAIL_NOT_VERIFIED",
        email: user.email,
      });
    }

    const jwtSecret = process.env.JWT_SECRET || "TU_SECRETO_SUPER_SECRETO";

    const jwtRefreshSecret =
      process.env.JWT_REFRESH_SECRET || "TU_SECRETO_REFRESH_SUPER_SECRETO";

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        type: "access",
      },
      jwtSecret,
      {
        expiresIn: "30m",
      },
    );

    const refreshToken = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        type: "refresh",
      },
      jwtRefreshSecret,
      {
        expiresIn: "30d",
      },
    );

    return res.json({
      token,
      refreshToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
};

export const refreshAccessToken = async (req: Request, res: Response) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(401).json({
      error: "Refresh token requerido",
    });
  }

  const jwtSecret = process.env.JWT_SECRET || "TU_SECRETO_SUPER_SECRETO";

  const jwtRefreshSecret =
    process.env.JWT_REFRESH_SECRET || "TU_SECRETO_REFRESH_SUPER_SECRETO";

  try {
    const decoded = jwt.verify(refreshToken, jwtRefreshSecret) as {
      id: number;
      email: string;
      role: string;
      type?: string;
    };

    if (decoded.type !== "refresh") {
      return res.status(401).json({
        error: "Refresh token inválido",
      });
    }

    const result = await pool.query(
      `
        SELECT
          id,
          email,
          role,
          email_verified_at
        FROM users
        WHERE id = $1
        LIMIT 1
      `,
      [decoded.id],
    );

    if (result.rowCount === 0) {
      return res.status(401).json({
        error: "Usuario no encontrado",
      });
    }

    const user = result.rows[0];

    if (!user.email_verified_at) {
      return res.status(403).json({
        error: "Correo no verificado",
        code: "EMAIL_NOT_VERIFIED",
      });
    }

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        type: "access",
      },
      jwtSecret,
      {
        expiresIn: "30m",
      },
    );

    return res.json({
      token,
    });
  } catch {
    return res.status(401).json({
      error: "Refresh token inválido o expirado",
    });
  }
};

export const getMe = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  try {
    const result = await pool.query(
      `
    SELECT
      id,
      email,
      name,
      last_name,
      role,
      email_verified_at,
      created_at
    FROM users
    WHERE id = $1
  `,
      [userId],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }
    return res.json(result.rows[0]);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const updateMe = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { name, last_name } = req.body;

  if (!name || !last_name) {
    return res
      .status(400)
      .json({ error: "Nombre y apellido son obligatorios" });
  }

  try {
    const result = await pool.query(
      "UPDATE users SET name=$1, last_name=$2 WHERE id=$3 RETURNING id, email, name, last_name, role",
      [name, last_name, userId],
    );
    return res.json(result.rows[0]);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const forgotPassword = async (req: Request, res: Response) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "El correo es obligatorio" });
  }

  const SUCCESS_MSG =
    "Si el correo está registrado, recibirás un enlace en breve";

  try {
    const result = await pool.query(
      "SELECT id, name FROM users WHERE email = $1",
      [email],
    );

    if (result.rowCount === 0) {
      return res.json({ message: SUCCESS_MSG });
    }

    const user = result.rows[0];
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await pool.query(
      "UPDATE password_reset_tokens SET used = true WHERE user_id = $1 AND used = false",
      [user.id],
    );

    await pool.query(
      "INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
      [user.id, token, expiresAt],
    );

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";

    const mobileAppUrl = process.env.MOBILE_APP_URL || "tocadapp://";

    const resetTarget =
      process.env.PASSWORD_RESET_TARGET === "mobile"
        ? mobileAppUrl
        : frontendUrl;

    const resetLink = `${resetTarget.replace(/\/$/, "")}/reset-password?token=${token}`;

    await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender: { email: process.env.EMAIL_FROM_ADDRESS, name: "TocadApp" },
        to: [{ email, name: user.name }],
        subject: "Recupera tu contraseña - TocadApp",
        htmlContent: `
          <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; background: #09090b; color: #fff; border-radius: 12px; padding: 40px; border: 1px solid #27272a;">
            <h2 style="color: #a855f7; margin-top: 0;">Recuperar contraseña</h2>
            <p style="color: #a1a1aa;">Hola <strong style="color: #fff;">${user.name}</strong>,</p>
            <p style="color: #a1a1aa;">Recibimos una solicitud para resetear tu contraseña en TocadApp. Haz clic en el botón para crear una nueva contraseña.</p>
            <p style="text-align: center; margin: 32px 0;">
              <a href="${resetLink}" style="background: #7e22ce; color: #fff; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">Resetear contraseña</a>
            </p>
            <p style="color: #71717a; font-size: 13px;">Este enlace expira en <strong style="color: #a1a1aa;">1 hora</strong>. Si no solicitaste esto, puedes ignorar este correo.</p>
            <hr style="border-color: #27272a; margin: 24px 0;" />
            <p style="color: #52525b; font-size: 12px; margin: 0;">TocadApp · La app para músicos</p>
          </div>
        `,
      },
      {
        headers: {
          "api-key": process.env.BREVO_API_KEY,
          "Content-Type": "application/json",
        },
      },
    );

    return res.json({ message: SUCCESS_MSG });
  } catch (error: any) {
    console.error("Error en forgotPassword:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
};

export const resetPassword = async (req: Request, res: Response) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res
      .status(400)
      .json({ error: "Token y nueva contraseña son obligatorios" });
  }

  if (password.length < 6) {
    return res
      .status(400)
      .json({ error: "La contraseña debe tener al menos 6 caracteres" });
  }

  try {
    const result = await pool.query(
      "SELECT id, user_id, expires_at, used FROM password_reset_tokens WHERE token = $1",
      [token],
    );

    if (result.rowCount === 0) {
      return res.status(400).json({ error: "El enlace no es válido" });
    }

    const resetToken = result.rows[0];

    if (resetToken.used) {
      return res.status(400).json({ error: "Este enlace ya fue utilizado" });
    }

    if (new Date() > new Date(resetToken.expires_at)) {
      return res
        .status(400)
        .json({ error: "El enlace ha expirado. Solicita uno nuevo" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.query("UPDATE users SET password = $1 WHERE id = $2", [
      hashedPassword,
      resetToken.user_id,
    ]);

    await pool.query(
      "UPDATE password_reset_tokens SET used = true WHERE id = $1",
      [resetToken.id],
    );

    return res.json({ message: "Contraseña actualizada correctamente" });
  } catch (error: any) {
    console.error("Error en resetPassword:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
};

export const getUsers = async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      "SELECT id, email, name, last_name, role, created_at FROM users",
    );
    return res.json({
      data: result.rows,
      total: result.rowCount,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};
