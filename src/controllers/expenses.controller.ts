import { Response } from "express";
import { pool } from "../lib/db";
import { AuthRequest } from "../middleware/auth";

export const getExpenses = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  try {
    const result = await pool.query(
      `SELECT * FROM expenses WHERE user_id = $1 ORDER BY date DESC, created_at DESC`,
      [userId],
    );
    return res.json({ ok: true, data: result.rows });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const createExpense = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { amount, category, description, date } = req.body;

  if (!amount || !category) {
    return res.status(400).json({ error: "Monto y categoría son obligatorios" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO expenses (user_id, amount, category, description, date)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [userId, amount, category, description || null, date || new Date().toISOString().split("T")[0]],
    );
    return res.status(201).json({ ok: true, data: result.rows[0] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const deleteExpense = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM expenses WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, userId],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Gasto no encontrado" });
    }
    return res.json({ ok: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};
