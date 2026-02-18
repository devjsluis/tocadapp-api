import { Request, Response } from "express";
import { pool } from "../lib/db";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

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
      "TU_SECRETO_SUPER_SECRETO",
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
