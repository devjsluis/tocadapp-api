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
              ge.collected_amount AS my_collected,
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
  const {
    title,
    place,
    date,
    time,
    amount,
    hours,
    notes,
    band_id,
    location_address,
    latitude,
    longitude,
    google_place_id,
  } = req.body;

  const userId = req.user!.id;

  const parsedHours = Number(hours);

  const hasLatitude =
    latitude !== null && latitude !== undefined && latitude !== "";

  const hasLongitude =
    longitude !== null && longitude !== undefined && longitude !== "";

  if (hasLatitude !== hasLongitude) {
    return res.status(400).json({
      error: "La latitud y longitud deben enviarse juntas",
    });
  }

  const parsedLatitude = hasLatitude ? Number(latitude) : null;
  const parsedLongitude = hasLongitude ? Number(longitude) : null;

  if (
    parsedLatitude !== null &&
    (!Number.isFinite(parsedLatitude) ||
      parsedLatitude < -90 ||
      parsedLatitude > 90)
  ) {
    return res.status(400).json({
      error: "La latitud no es válida",
    });
  }

  if (
    parsedLongitude !== null &&
    (!Number.isFinite(parsedLongitude) ||
      parsedLongitude < -180 ||
      parsedLongitude > 180)
  ) {
    return res.status(400).json({
      error: "La longitud no es válida",
    });
  }

  if (!Number.isFinite(parsedHours) || parsedHours <= 0) {
    return res.status(400).json({
      error: "La duración debe ser un número mayor a 0",
    });
  }

  const normalizedBandId =
    band_id === "" || band_id === null || band_id === undefined
      ? null
      : Number(band_id);

  if (normalizedBandId !== null) {
    const bandCheck = await pool.query(
      `SELECT b.id
     FROM bands b
     LEFT JOIN band_members bm
       ON bm.band_id = b.id
       AND bm.user_id = $2
     WHERE b.id = $1
       AND b.archived_at IS NULL
       AND (b.owner_id = $2 OR bm.can_create_gigs = TRUE)`,
      [normalizedBandId, userId],
    );

    if (bandCheck.rowCount === 0) {
      return res.status(403).json({
        error: "No tienes permiso para asignar esta tocada a esta banda",
      });
    }
  }

  const sql = `
    INSERT INTO gigs (
      title,
      place,
      date,
      time,
      amount,
      hours,
      notes,
      user_id,
      band_id,
      location_address,
      latitude,
      longitude,
      google_place_id
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12, $13
    )
    RETURNING *
  `;

  try {
    const result = await pool.query(sql, [
      title,
      place,
      date,
      time,
      amount ?? null,
      parsedHours,
      notes?.trim() || null,
      userId,
      normalizedBandId,
      location_address?.trim() || null,
      parsedLatitude,
      parsedLongitude,
      google_place_id?.trim() || null,
    ]);

    return res.status(201).json(result.rows[0]);
  } catch (error: any) {
    console.error("Error al crear tocada:", error);

    return res.status(500).json({
      error: error.message,
    });
  }
};

export const updateGig = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const {
    title,
    place,
    date,
    time,
    amount,
    hours,
    notes,
    band_id,
    location_address,
    latitude,
    longitude,
    google_place_id,
  } = req.body;
  const userId = req.user!.id;

  const parsedHours = Number(hours);

  const hasLatitude =
    latitude !== null && latitude !== undefined && latitude !== "";

  const hasLongitude =
    longitude !== null && longitude !== undefined && longitude !== "";

  if (hasLatitude !== hasLongitude) {
    return res.status(400).json({
      error: "La latitud y longitud deben enviarse juntas",
    });
  }

  const parsedLatitude = hasLatitude ? Number(latitude) : null;
  const parsedLongitude = hasLongitude ? Number(longitude) : null;

  if (
    parsedLatitude !== null &&
    (!Number.isFinite(parsedLatitude) ||
      parsedLatitude < -90 ||
      parsedLatitude > 90)
  ) {
    return res.status(400).json({
      error: "La latitud no es válida",
    });
  }

  if (
    parsedLongitude !== null &&
    (!Number.isFinite(parsedLongitude) ||
      parsedLongitude < -180 ||
      parsedLongitude > 180)
  ) {
    return res.status(400).json({
      error: "La longitud no es válida",
    });
  }

  if (!Number.isFinite(parsedHours) || parsedHours <= 0) {
    return res.status(400).json({
      error: "La duración debe ser un número mayor a 0",
    });
  }

  const normalizedBandId =
    band_id === "" || band_id === null || band_id === undefined
      ? null
      : Number(band_id);

  const currentGigResult = await pool.query(
    `SELECT band_id
   FROM gigs
   WHERE id = $1
     AND (
       user_id = $2
       OR (
         band_id IS NOT NULL
         AND band_id IN (
           SELECT id
           FROM bands
           WHERE owner_id = $2
         )
       )
     )`,
    [id, userId],
  );

  if (currentGigResult.rowCount === 0) {
    return res.status(404).json({
      error: "Tocada no encontrada o no autorizado",
    });
  }

  const currentBandId =
    currentGigResult.rows[0].band_id !== null
      ? Number(currentGigResult.rows[0].band_id)
      : null;

  const isKeepingSameBand = currentBandId === normalizedBandId;

  if (normalizedBandId !== null && !isKeepingSameBand) {
    const bandCheck = await pool.query(
      `SELECT b.id
     FROM bands b
     LEFT JOIN band_members bm
       ON bm.band_id = b.id
       AND bm.user_id = $2
     WHERE b.id = $1
       AND b.archived_at IS NULL
       AND (b.owner_id = $2 OR bm.can_create_gigs = TRUE)`,
      [normalizedBandId, userId],
    );

    if (bandCheck.rowCount === 0) {
      return res.status(403).json({
        error: "No tienes permiso para asignar esta tocada a esta banda",
      });
    }
  }

  const sql = `
  UPDATE gigs
  SET
    title = $1,
    place = $2,
    date = $3,
    time = $4,
    amount = $5,
    hours = $6,
    notes = $7,
    band_id = $8,
    location_address = $9,
    latitude = $10,
    longitude = $11,
    google_place_id = $12
  WHERE id = $13
    AND (
      user_id = $14
      OR (
        band_id IS NOT NULL
        AND band_id IN (
          SELECT id
          FROM bands
          WHERE owner_id = $14
        )
      )
    )
  RETURNING *
`;

  try {
    const result = await pool.query(sql, [
      title,
      place,
      date,
      time,
      amount ?? null,
      parsedHours,
      notes?.trim() || null,
      normalizedBandId,
      location_address?.trim() || null,
      parsedLatitude,
      parsedLongitude,
      google_place_id?.trim() || null,
      id,
      userId,
    ]);

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "Tocada no encontrada o no autorizado",
      });
    }

    return res.json(result.rows[0]);
  } catch (error: any) {
    console.error("Error al actualizar tocada:", error);

    return res.status(500).json({
      error: error.message,
    });
  }
};

export const setMyEarnings = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { amount, collected_amount } = req.body;
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
      return res
        .status(404)
        .json({ error: "Gig no encontrada o no autorizado" });
    }

    const result = await pool.query(
      `INSERT INTO gig_earnings (gig_id, user_id, amount, collected_amount)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (gig_id, user_id)
       DO UPDATE SET amount = $3, collected_amount = $4
       RETURNING *`,
      [id, userId, amount, collected_amount ?? null],
    );
    return res.json({ ok: true, data: result.rows[0] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const setCollected = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { amount } = req.body;
  const userId = req.user!.id;

  try {
    const result = await pool.query(
      `UPDATE gigs SET collected_amount = $1
       WHERE id = $2 AND user_id = $3
       RETURNING id, collected_amount`,
      [amount ?? null, id, userId],
    );
    if (result.rowCount === 0) {
      return res
        .status(404)
        .json({ error: "Tocada no encontrada o no autorizado" });
    }
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
      return res
        .status(404)
        .json({ error: "Gig no encontrada o no autorizado" });
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
