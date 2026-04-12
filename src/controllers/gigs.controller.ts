import { Response } from "express";
import { pool } from "../lib/db";
import { AuthRequest } from "../middleware/auth";

export const getGigs = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  try {
    const result = await pool.query(
      `SELECT g.*, b.name AS band_name,
              (g.user_id = $1) AS is_owner,
              ge.amount AS my_amount,
              ga.attending AS my_attending
       FROM gigs g
       LEFT JOIN bands b ON g.band_id = b.id
       LEFT JOIN gig_earnings ge ON ge.gig_id = g.id AND ge.user_id = $1
       LEFT JOIN gig_attendance ga ON ga.gig_id = g.id AND ga.user_id = $1
       WHERE g.user_id = $1
          OR (g.band_id IS NOT NULL AND g.band_id IN (
            SELECT band_id FROM band_members WHERE user_id = $1
          ))
       ORDER BY g.date ASC`,
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

export const createGig = async (req: AuthRequest, res: Response) => {
  const { title, place, date, time, amount, hours, notes, band_id } = req.body;
  const userId = req.user!.id;

  if (band_id) {
    const bandCheck = await pool.query(
      `SELECT b.id FROM bands b
       LEFT JOIN band_members bm ON bm.band_id = b.id AND bm.user_id = $2
       WHERE b.id = $1 AND (b.owner_id = $2 OR bm.can_create_gigs = TRUE)`,
      [band_id, userId],
    );
    if (bandCheck.rowCount === 0) {
      return res
        .status(403)
        .json({ error: "No tienes permiso para agregar tocadas a esta banda" });
    }
  }

  const sql = `
    INSERT INTO gigs (title, place, date, time, amount, hours, notes, user_id, band_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *`;

  try {
    const result = await pool.query(sql, [
      title,
      place,
      date,
      time,
      amount,
      hours,
      notes || null,
      userId,
      band_id || null,
    ]);
    return res.status(201).json(result.rows[0]);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const updateGig = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { title, place, date, time, amount, hours, notes, band_id } = req.body;
  const userId = req.user!.id;

  const sql = `
    UPDATE gigs
    SET title=$1, place=$2, date=$3, time=$4, amount=$5, hours=$6, notes=$7, band_id=$8
    WHERE id=$9
      AND (user_id=$10
           OR (band_id IS NOT NULL AND band_id IN (SELECT id FROM bands WHERE owner_id = $10)))
    RETURNING *`;

  try {
    const result = await pool.query(sql, [
      title,
      place,
      date,
      time,
      amount,
      hours,
      notes || null,
      band_id || null,
      id,
      userId,
    ]);
    if (result.rowCount === 0) {
      return res
        .status(404)
        .json({ error: "Tocada no encontrada o no autorizado" });
    }
    return res.json(result.rows[0]);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const setMyEarnings = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { amount } = req.body;
  const userId = req.user!.id;

  if (amount === undefined || amount === null || amount === "") {
    return res.status(400).json({ error: "El monto es obligatorio" });
  }

  try {
    // Verificar que el usuario puede ver este gig
    const gigCheck = await pool.query(
      `SELECT g.id FROM gigs g
       WHERE g.id = $1
         AND (g.user_id = $2
              OR (g.band_id IS NOT NULL AND g.band_id IN (
                SELECT band_id FROM band_members WHERE user_id = $2
              )))`,
      [id, userId],
    );
    if (gigCheck.rowCount === 0) {
      return res.status(404).json({ error: "Gig no encontrada o no autorizado" });
    }

    const result = await pool.query(
      `INSERT INTO gig_earnings (gig_id, user_id, amount)
       VALUES ($1, $2, $3)
       ON CONFLICT (gig_id, user_id)
       DO UPDATE SET amount = $3
       RETURNING *`,
      [id, userId, amount],
    );
    return res.json({ ok: true, data: result.rows[0] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const setAttending = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { attending } = req.body;
  const userId = req.user!.id;

  try {
    const gigCheck = await pool.query(
      `SELECT g.id FROM gigs g
       WHERE g.id = $1
         AND (g.user_id = $2
              OR (g.band_id IS NOT NULL AND g.band_id IN (
                SELECT band_id FROM band_members WHERE user_id = $2
              )))`,
      [id, userId],
    );
    if (gigCheck.rowCount === 0) {
      return res.status(404).json({ error: "Gig no encontrada o no autorizado" });
    }

    if (attending === null || attending === undefined) {
      await pool.query(
        "DELETE FROM gig_attendance WHERE gig_id = $1 AND user_id = $2",
        [id, userId],
      );
    } else {
      await pool.query(
        `INSERT INTO gig_attendance (gig_id, user_id, attending)
         VALUES ($1, $2, $3)
         ON CONFLICT (gig_id, user_id) DO UPDATE SET attending = $3`,
        [id, userId, attending],
      );
    }
    return res.json({ ok: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const deleteGig = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const userId = req.user!.id;

  try {
    const result = await pool.query(
      `DELETE FROM gigs WHERE id=$1
       AND (user_id=$2
            OR (band_id IS NOT NULL AND band_id IN (SELECT id FROM bands WHERE owner_id = $2)))
       RETURNING *`,
      [id, userId],
    );
    if (result.rowCount === 0) {
      return res
        .status(404)
        .json({ error: "Tocada no encontrada o no autorizado" });
    }
    return res.json({ ok: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};
