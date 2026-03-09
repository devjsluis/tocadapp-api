import { Request, Response } from "express";
import { pool } from "../lib/db";

export const getGigs = async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      "SELECT * FROM gigs ORDER BY date ASC",
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

export const updateGig = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { title, place, date, time, amount, hours, notes } = req.body;

  const sql = `
    UPDATE gigs
    SET title=$1, place=$2, date=$3, time=$4, amount=$5, hours=$6, notes=$7
    WHERE id=$8
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
      id,
    ]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Tocada no encontrada" });
    }
    return res.json(result.rows[0]);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const deleteGig = async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      "DELETE FROM gigs WHERE id=$1 RETURNING *",
      [id],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Tocada no encontrada" });
    }
    return res.json({ ok: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};
