import { Request, Response } from "express";
import { pool } from "../lib/db";

export const getMusicians = async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      "SELECT * FROM musicians ORDER BY name ASC",
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

export const createMusician = async (req: Request, res: Response) => {
  const { name, instrument, phone, notes } = req.body;

  if (!name) {
    return res.status(400).json({ error: "El nombre es obligatorio" });
  }

  const sql = `
    INSERT INTO musicians (name, instrument, phone, notes)
    VALUES ($1, $2, $3, $4)
    RETURNING *`;

  try {
    const result = await pool.query(sql, [
      name,
      instrument || null,
      phone || null,
      notes || null,
    ]);
    return res.status(201).json(result.rows[0]);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const deleteMusician = async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      "DELETE FROM musicians WHERE id = $1 RETURNING *",
      [id],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Músico no encontrado" });
    }
    return res.json({ ok: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};
