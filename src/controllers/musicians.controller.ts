import { Response } from "express";
import { pool } from "../lib/db";
import { AuthRequest } from "../middleware/auth";

export const getMusicians = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  try {
    const result = await pool.query(
      "SELECT * FROM musicians WHERE user_id = $1 ORDER BY name ASC",
      [userId],
    );
    return res.json({
      ok: true,
      data: result.rows,
      totals: { count: result.rowCount },
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const createMusician = async (req: AuthRequest, res: Response) => {
  const { name, instrument, phone, notes } = req.body;
  const userId = req.user!.id;

  if (!name) {
    return res.status(400).json({ error: "El nombre es obligatorio" });
  }

  const sql = `
    INSERT INTO musicians (name, instrument, phone, notes, user_id)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *`;

  try {
    const result = await pool.query(sql, [
      name,
      instrument || null,
      phone || null,
      notes || null,
      userId,
    ]);
    return res.status(201).json(result.rows[0]);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const deleteMusician = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const userId = req.user!.id;

  try {
    const result = await pool.query(
      "DELETE FROM musicians WHERE id = $1 AND user_id = $2 RETURNING *",
      [id, userId],
    );
    if (result.rowCount === 0) {
      return res
        .status(404)
        .json({ error: "Músico no encontrado o no autorizado" });
    }
    return res.json({ ok: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};
