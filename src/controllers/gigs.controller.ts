import { Request, Response } from "express";
import { pool } from "../lib/db";

export const getGigs = async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      "SELECT * FROM gigs ORDER BY created_at DESC",
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

export const createGig = async (req: Request, res: Response) => {
  const { title, place, date, time, amount, hours, notes } = req.body;

  const sql = `
    INSERT INTO gigs (title, place, date, time, amount, hours, notes)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *`;

  try {
    const result = await pool.query(sql, [
      title,
      place,
      date,
      time,
      amount,
      hours,
      notes,
    ]);
    return res.status(201).json(result.rows[0]);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};
