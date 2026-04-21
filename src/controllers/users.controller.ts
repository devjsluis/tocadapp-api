import { Request, Response } from "express";
import { pool } from "../lib/db";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { randomBytes } from "crypto";
import axios from "axios";
import { AuthRequest } from "../middleware/auth";

export const createUser = async (req: Request, res: Response) => {
  const { email, name, lastName, password, role } = req.body;

  if (!email || !name || !lastName || !password || !role) {
    return res.status(400).json({
      error:
        "Todos los campos (nombre, apellido, correo, contraseña y rol) son obligatorios",
    });
  }

  try {
    const existingUser = await pool.query(
      "SELECT email FROM users WHERE email = $1",
      [email],
    );

    if (existingUser.rowCount! > 0) {
      return res.status(400).json({
        error: "Este correo electrónico ya está registrado",
      });
    }

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const result = await pool.query(
      "INSERT INTO users (email, name, last_name, password, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, name, last_name, role, created_at",
      [email, name, lastName, hashedPassword, role],
    );

    return res.status(201).json(result.rows[0]);
  } catch (error: any) {
    console.error("Error en BD:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
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
      return res.status(401).json({ error: "Contraseña incorrecta" });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET || "TU_SECRETO_SUPER_SECRETO",
      { expiresIn: "24h" },
    );

    return res.json({
      token,
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

export const getMe = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  try {
    const result = await pool.query(
      "SELECT id, email, name, last_name, role, created_at FROM users WHERE id = $1",
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
    return res.status(400).json({ error: "Nombre y apellido son obligatorios" });
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

  const SUCCESS_MSG = "Si el correo está registrado, recibirás un enlace en breve";

  try {
    const result = await pool.query(
      "SELECT id, name FROM users WHERE email = $1",
      [email]
    );

    if (result.rowCount === 0) {
      return res.json({ message: SUCCESS_MSG });
    }

    const user = result.rows[0];
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await pool.query(
      "UPDATE password_reset_tokens SET used = true WHERE user_id = $1 AND used = false",
      [user.id]
    );

    await pool.query(
      "INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)",
      [user.id, token, expiresAt]
    );

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const resetLink = `${frontendUrl}/reset-password?token=${token}`;

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
      }
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
    return res.status(400).json({ error: "Token y nueva contraseña son obligatorios" });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres" });
  }

  try {
    const result = await pool.query(
      "SELECT id, user_id, expires_at, used FROM password_reset_tokens WHERE token = $1",
      [token]
    );

    if (result.rowCount === 0) {
      return res.status(400).json({ error: "El enlace no es válido" });
    }

    const resetToken = result.rows[0];

    if (resetToken.used) {
      return res.status(400).json({ error: "Este enlace ya fue utilizado" });
    }

    if (new Date() > new Date(resetToken.expires_at)) {
      return res.status(400).json({ error: "El enlace ha expirado. Solicita uno nuevo" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.query("UPDATE users SET password = $1 WHERE id = $2", [
      hashedPassword,
      resetToken.user_id,
    ]);

    await pool.query(
      "UPDATE password_reset_tokens SET used = true WHERE id = $1",
      [resetToken.id]
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
