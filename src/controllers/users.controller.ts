import { Request, Response } from "express";
import { pool } from "../lib/db";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
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
