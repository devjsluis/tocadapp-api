import { Request, Response } from "express";
import { pool } from "../lib/db";
import bcrypt from "bcrypt";

export const getUsers = async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      "SELECT id, email, name, created_at FROM users",
    );
    return res.json({
      data: result.rows,
      total: result.rowCount,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const createUser = async (req: Request, res: Response) => {
  const { email, name, password } = req.body;

  if (!email || !name || !password) {
    return res.status(400).json({
      error: "El correo, el nombre y la contraseña son campos obligatorios",
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
      "INSERT INTO users (email, name, password) VALUES ($1, $2, $3) RETURNING *",
      [email, name, hashedPassword],
    );

    const newUser = result.rows[0];

    const { password: _, ...userWithoutPassword } = newUser;

    return res.status(201).json(userWithoutPassword);
  } catch (error: any) {
    if (error.code === "23505") {
      return res.status(400).json({ error: "El correo ya existe" });
    }
    return res.status(500).json({ error: "Error interno del servidor" });
  }
};
