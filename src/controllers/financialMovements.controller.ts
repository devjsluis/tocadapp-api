import { Response } from "express";

import { pool } from "../lib/db";
import { AuthRequest } from "../middleware/auth";

type MovementType = "INCOME" | "EXPENSE";

function normalizeMovementType(value: unknown): MovementType | null {
  if (value === "INCOME" || value === "EXPENSE") {
    return value;
  }

  return null;
}

async function userCanAccessGig(
  userId: number,
  gigId: number,
): Promise<boolean> {
  const result = await pool.query(
    `
      SELECT g.id
      FROM gigs g
      WHERE g.id = $1
        AND (
          g.user_id = $2
          OR (
            g.band_id IS NOT NULL
            AND g.band_id IN (
              SELECT bm.band_id
              FROM band_members bm
              WHERE bm.user_id = $2
            )
          )
        )
      LIMIT 1
    `,
    [gigId, userId],
  );

  return (result.rowCount ?? 0) > 0;
}

async function userCanAccessBand(
  userId: number,
  bandId: number,
): Promise<boolean> {
  const result = await pool.query(
    `
      SELECT b.id
      FROM bands b
      LEFT JOIN band_members bm
        ON bm.band_id = b.id
       AND bm.user_id = $2
      WHERE b.id = $1
        AND (
          b.owner_id = $2
          OR bm.user_id = $2
        )
      LIMIT 1
    `,
    [bandId, userId],
  );

  return (result.rowCount ?? 0) > 0;
}

export const getFinancialMovements = async (
  req: AuthRequest,
  res: Response,
) => {
  const userId = req.user!.id;

  const type = req.query.type;
  const gigId = req.query.gigId;

  const conditions = ["fm.user_id = $1"];
  const values: Array<string | number> = [userId];

  if (type !== undefined) {
    const normalizedType = normalizeMovementType(type);

    if (!normalizedType) {
      return res.status(400).json({
        error: "Tipo de movimiento inválido",
      });
    }

    values.push(normalizedType);
    conditions.push(`fm.type = $${values.length}`);
  }

  if (gigId !== undefined) {
    const parsedGigId = Number(gigId);

    if (!Number.isInteger(parsedGigId) || parsedGigId <= 0) {
      return res.status(400).json({
        error: "La tocada indicada no es válida",
      });
    }

    values.push(parsedGigId);
    conditions.push(`fm.gig_id = $${values.length}`);
  }

  try {
    const result = await pool.query(
      `
        SELECT
          fm.*,
          g.title AS gig_title,
          g.date AS gig_date,
          g.place AS gig_place,
          b.name AS band_name
        FROM financial_movements fm
        LEFT JOIN gigs g
          ON g.id = fm.gig_id
        LEFT JOIN bands b
          ON b.id = COALESCE(g.band_id, fm.band_id)
        WHERE ${conditions.join(" AND ")}
        ORDER BY
          fm.date DESC,
          fm.created_at DESC
      `,
      values,
    );

    return res.json({
      ok: true,
      data: result.rows,
    });
  } catch (error: any) {
    console.error("Error al obtener movimientos financieros:", error);

    return res.status(500).json({
      error: "No fue posible obtener los movimientos financieros",
    });
  }
};

export const createFinancialMovement = async (
  req: AuthRequest,
  res: Response,
) => {
  const userId = req.user!.id;

  const { type, amount, category, description, date, gig_id, band_id } =
    req.body;

  const normalizedType = normalizeMovementType(type);

  if (!normalizedType) {
    return res.status(400).json({
      error: "El tipo debe ser INCOME o EXPENSE",
    });
  }

  const parsedAmount = Number(amount);

  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({
      error: "El monto debe ser mayor a cero",
    });
  }

  const normalizedCategory = String(category ?? "").trim();

  if (!normalizedCategory) {
    return res.status(400).json({
      error: "La categoría es obligatoria",
    });
  }

  let normalizedGigId: number | null = null;
  let normalizedBandId: number | null = null;

  if (band_id !== null && band_id !== undefined && band_id !== "") {
    const parsedBandId = Number(band_id);

    if (!Number.isInteger(parsedBandId) || parsedBandId <= 0) {
      return res.status(400).json({
        error: "La banda indicada no es válida",
      });
    }

    const canAccess = await userCanAccessBand(userId, parsedBandId);

    if (!canAccess) {
      return res.status(403).json({
        error: "No tienes acceso a la banda seleccionada",
      });
    }

    normalizedBandId = parsedBandId;
  }

  if (gig_id !== null && gig_id !== undefined && gig_id !== "") {
    const parsedGigId = Number(gig_id);

    if (!Number.isInteger(parsedGigId) || parsedGigId <= 0) {
      return res.status(400).json({
        error: "La tocada indicada no es válida",
      });
    }

    const canAccess = await userCanAccessGig(userId, parsedGigId);

    if (!canAccess) {
      return res.status(403).json({
        error: "No tienes acceso a la tocada seleccionada",
      });
    }

    normalizedGigId = parsedGigId;
  }

  if (normalizedGigId !== null) {
    const gigResult = await pool.query(
      `
      SELECT band_id
      FROM gigs
      WHERE id = $1
      LIMIT 1
    `,
      [normalizedGigId],
    );

    normalizedBandId =
      gigResult.rows[0]?.band_id != null
        ? Number(gigResult.rows[0].band_id)
        : null;
  }

  const normalizedDescription =
    typeof description === "string" && description.trim()
      ? description.trim()
      : null;

  const normalizedDate =
    typeof date === "string" && date.trim()
      ? date.trim()
      : new Date().toISOString().slice(0, 10);

  try {
    const result = await pool.query(
      `
        INSERT INTO financial_movements (
          user_id,
          gig_id,
          band_id,
          type,
          amount,
          category,
          description,
          date
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8
        )
        RETURNING *
      `,
      [
        userId,
        normalizedGigId,
        normalizedBandId,
        normalizedType,
        parsedAmount,
        normalizedCategory,
        normalizedDescription,
        normalizedDate,
      ],
    );

    return res.status(201).json({
      ok: true,
      data: result.rows[0],
    });
  } catch (error: any) {
    console.error("Error al crear movimiento financiero:", error);

    return res.status(500).json({
      error: "No fue posible registrar el movimiento financiero",
    });
  }
};

export const updateFinancialMovement = async (
  req: AuthRequest,
  res: Response,
) => {
  const userId = req.user!.id;
  const movementId = Number(req.params.id);

  if (!Number.isInteger(movementId) || movementId <= 0) {
    return res.status(400).json({
      error: "Movimiento inválido",
    });
  }

  const { type, amount, category, description, date, gig_id, band_id } =
    req.body;

  const normalizedType = normalizeMovementType(type);

  if (!normalizedType) {
    return res.status(400).json({
      error: "El tipo debe ser INCOME o EXPENSE",
    });
  }

  const parsedAmount = Number(amount);

  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({
      error: "El monto debe ser mayor a cero",
    });
  }

  const normalizedCategory = String(category ?? "").trim();

  if (!normalizedCategory) {
    return res.status(400).json({
      error: "La categoría es obligatoria",
    });
  }

  let normalizedGigId: number | null = null;
  let normalizedBandId: number | null = null;

  if (band_id !== null && band_id !== undefined && band_id !== "") {
    const parsedBandId = Number(band_id);

    if (!Number.isInteger(parsedBandId) || parsedBandId <= 0) {
      return res.status(400).json({
        error: "La banda indicada no es válida",
      });
    }

    const canAccess = await userCanAccessBand(userId, parsedBandId);

    if (!canAccess) {
      return res.status(403).json({
        error: "No tienes acceso a la banda seleccionada",
      });
    }

    normalizedBandId = parsedBandId;
  }

  if (gig_id !== null && gig_id !== undefined && gig_id !== "") {
    const parsedGigId = Number(gig_id);

    if (!Number.isInteger(parsedGigId) || parsedGigId <= 0) {
      return res.status(400).json({
        error: "La tocada indicada no es válida",
      });
    }

    const canAccess = await userCanAccessGig(userId, parsedGigId);

    if (!canAccess) {
      return res.status(403).json({
        error: "No tienes acceso a la tocada seleccionada",
      });
    }

    normalizedGigId = parsedGigId;
  }

  if (normalizedGigId !== null) {
    const gigResult = await pool.query(
      `
      SELECT band_id
      FROM gigs
      WHERE id = $1
      LIMIT 1
    `,
      [normalizedGigId],
    );

    normalizedBandId =
      gigResult.rows[0]?.band_id != null
        ? Number(gigResult.rows[0].band_id)
        : null;
  }

  const normalizedDescription =
    typeof description === "string" && description.trim()
      ? description.trim()
      : null;

  const normalizedDate =
    typeof date === "string" && date.trim()
      ? date.trim()
      : new Date().toISOString().slice(0, 10);

  try {
    const result = await pool.query(
      `
        UPDATE financial_movements
        SET
          gig_id = $1,
          band_id = $2,
          type = $3,
          amount = $4,
          category = $5,
          description = $6,
          date = $7,
          updated_at = NOW()
        WHERE id = $8
          AND user_id = $9
        RETURNING *
      `,
      [
        normalizedGigId,
        normalizedBandId,
        normalizedType,
        parsedAmount,
        normalizedCategory,
        normalizedDescription,
        normalizedDate,
        movementId,
        userId,
      ],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "Movimiento no encontrado",
      });
    }

    return res.json({
      ok: true,
      data: result.rows[0],
    });
  } catch (error: any) {
    console.error("Error al actualizar movimiento financiero:", error);

    return res.status(500).json({
      error: "No fue posible actualizar el movimiento financiero",
    });
  }
};

export const deleteFinancialMovement = async (
  req: AuthRequest,
  res: Response,
) => {
  const userId = req.user!.id;
  const movementId = Number(req.params.id);

  if (!Number.isInteger(movementId) || movementId <= 0) {
    return res.status(400).json({
      error: "Movimiento inválido",
    });
  }

  try {
    const result = await pool.query(
      `
        DELETE FROM financial_movements
        WHERE id = $1
          AND user_id = $2
        RETURNING id
      `,
      [movementId, userId],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "Movimiento no encontrado",
      });
    }

    return res.json({
      ok: true,
    });
  } catch (error: any) {
    console.error("Error al eliminar movimiento financiero:", error);

    return res.status(500).json({
      error: "No fue posible eliminar el movimiento financiero",
    });
  }
};
