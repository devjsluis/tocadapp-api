import { Response } from "express";
import { pool } from "../lib/db";
import { AuthRequest } from "../middleware/auth";

function generateInviteCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(
    { length: 6 },
    () => chars[Math.floor(Math.random() * chars.length)],
  ).join("");
}

export const getBands = async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const status = String(req.query.status ?? "active");

  if (!["active", "archived", "all"].includes(status)) {
    return res.status(400).json({
      error: "Estado de banda inválido",
    });
  }

  const archiveCondition =
    status === "archived"
      ? "AND b.archived_at IS NOT NULL"
      : status === "all"
        ? ""
        : "AND b.archived_at IS NULL";

  try {
    const result = await pool.query(
      `SELECT b.*,
              (b.owner_id = $1) AS is_owner,
              u.name AS owner_name,
              u.last_name AS owner_last_name,
              (SELECT COUNT(*) FROM band_members bm WHERE bm.band_id = b.id)::int AS member_count,
              COALESCE(my_membership.can_create_gigs, FALSE) AS can_create_gigs
       FROM bands b
       JOIN users u ON b.owner_id = u.id
       LEFT JOIN band_members my_membership ON my_membership.band_id = b.id AND my_membership.user_id = $1
       WHERE (
          b.owner_id = $1
          OR b.id IN (SELECT band_id FROM band_members WHERE user_id = $1)
        )
        ${archiveCondition}
       ORDER BY b.created_at ASC`,
      [userId],
    );
    return res.json({ ok: true, data: result.rows });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const createBand = async (req: AuthRequest, res: Response) => {
  const { name, description } = req.body;
  const userId = req.user!.id;

  if (!name) {
    return res
      .status(400)
      .json({ error: "El nombre de la banda es obligatorio" });
  }

  let invite_code = generateInviteCode();
  for (let i = 0; i < 10; i++) {
    const existing = await pool.query(
      "SELECT id FROM bands WHERE invite_code = $1",
      [invite_code],
    );
    if (existing.rowCount === 0) break;
    invite_code = generateInviteCode();
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const bandResult = await client.query(
      `INSERT INTO bands (name, description, owner_id, invite_code)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, description || null, userId, invite_code],
    );
    const band = bandResult.rows[0];

    await client.query(
      "INSERT INTO band_members (band_id, user_id, role) VALUES ($1, $2, $3)",
      [band.id, userId, "leader"],
    );

    await client.query("COMMIT");
    return res.status(201).json({
      ok: true,
      data: { ...band, is_owner: true, member_count: 1 },
    });
  } catch (error: any) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
};

export const joinBand = async (req: AuthRequest, res: Response) => {
  const { invite_code } = req.body;
  const userId = req.user!.id;

  if (!invite_code) {
    return res.status(400).json({ error: "Código de invitación requerido" });
  }

  try {
    const bandResult = await pool.query(
      `SELECT *
       FROM bands
       WHERE invite_code = $1
        AND archived_at IS NULL`,
      [String(invite_code).trim().toUpperCase()],
    );

    if (bandResult.rowCount === 0) {
      return res.status(404).json({ error: "Código de invitación inválido" });
    }

    const band = bandResult.rows[0];

    if (band.owner_id === userId) {
      return res
        .status(400)
        .json({ error: "Ya eres el encargado de esta banda" });
    }

    const existing = await pool.query(
      "SELECT id FROM band_members WHERE band_id = $1 AND user_id = $2",
      [band.id, userId],
    );
    if (existing.rowCount! > 0) {
      return res.status(400).json({ error: "Ya eres miembro de esta banda" });
    }

    await pool.query(
      "INSERT INTO band_members (band_id, user_id, role) VALUES ($1, $2, $3)",
      [band.id, userId, "musician"],
    );

    return res.json({ ok: true, data: band });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const getBandMembers = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const userId = req.user!.id;

  try {
    const memberCheck = await pool.query(
      "SELECT id FROM band_members WHERE band_id = $1 AND user_id = $2",
      [id, userId],
    );
    if (memberCheck.rowCount === 0) {
      return res.status(403).json({ error: "No eres miembro de esta banda" });
    }

    const result = await pool.query(
      `SELECT u.id, u.name, u.last_name, u.email, bm.role, bm.joined_at, bm.can_create_gigs
       FROM band_members bm
       JOIN users u ON bm.user_id = u.id
       WHERE bm.band_id = $1
       ORDER BY bm.role DESC, u.name ASC`,
      [id],
    );
    return res.json({ ok: true, data: result.rows });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const archiveBand = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const userId = req.user!.id;

  try {
    const result = await pool.query(
      `UPDATE bands
       SET archived_at = NOW()
       WHERE id = $1
         AND owner_id = $2
         AND archived_at IS NULL
       RETURNING *`,
      [id, userId],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "Banda no encontrada, no autorizada o ya deshabilitada",
      });
    }

    return res.json({ ok: true, data: result.rows[0] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const restoreBand = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const userId = req.user!.id;

  try {
    const result = await pool.query(
      `UPDATE bands
       SET archived_at = NULL
       WHERE id = $1
         AND owner_id = $2
         AND archived_at IS NOT NULL
       RETURNING *`,
      [id, userId],
    );

    if (result.rowCount === 0) {
      return res
        .status(404)
        .json({ error: "Banda no encontrada, no autorizada o ya habilitada" });
    }

    return res.json({ ok: true, data: result.rows[0] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const deleteBand = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const userId = req.user!.id;

  try {
    const bandResult = await pool.query(
      `SELECT id
       FROM bands
       WHERE id = $1
         AND owner_id = $2`,
      [id, userId],
    );

    if (bandResult.rowCount === 0) {
      return res
        .status(404)
        .json({ error: "Banda no encontrada o no autorizado" });
    }

    const historyResult = await pool.query(
      `SELECT
         EXISTS (
           SELECT 1
           FROM gigs
           WHERE band_id = $1
         ) AS has_gigs,
         EXISTS (
           SELECT 1
           FROM financial_movements
           WHERE band_id = $1
         ) AS has_movements`,
      [id],
    );

    const { has_gigs, has_movements } = historyResult.rows[0];

    if (has_gigs || has_movements) {
      return res.status(409).json({
        error:
          "Esta banda tiene historial y no puede eliminarse. Deshabilítala en su lugar.",
      });
    }

    await pool.query(
      `DELETE FROM bands
       WHERE id = $1
         AND owner_id = $2`,
      [id, userId],
    );

    return res.json({ ok: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const updateMemberPermissions = async (
  req: AuthRequest,
  res: Response,
) => {
  const { id, userId } = req.params;
  const { can_create_gigs } = req.body;
  const requesterId = req.user!.id;

  if (typeof can_create_gigs !== "boolean") {
    return res
      .status(400)
      .json({ error: "can_create_gigs debe ser un booleano" });
  }

  try {
    const bandCheck = await pool.query(
      `SELECT id
   FROM bands
   WHERE id = $1
     AND owner_id = $2
     AND archived_at IS NULL`,
      [id, requesterId],
    );
    if (bandCheck.rowCount === 0) {
      return res
        .status(403)
        .json({ error: "Solo el encargado puede modificar permisos" });
    }

    const result = await pool.query(
      "UPDATE band_members SET can_create_gigs = $1 WHERE band_id = $2 AND user_id = $3 RETURNING *",
      [can_create_gigs, id, userId],
    );
    if (result.rowCount === 0) {
      return res
        .status(404)
        .json({ error: "Miembro no encontrado en esta banda" });
    }
    return res.json({ ok: true, data: result.rows[0] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};

export const leaveBand = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const userId = req.user!.id;

  try {
    const bandResult = await pool.query(
      "SELECT owner_id FROM bands WHERE id = $1",
      [id],
    );
    if (bandResult.rowCount === 0) {
      return res.status(404).json({ error: "Banda no encontrada" });
    }
    if (bandResult.rows[0].owner_id === userId) {
      return res.status(400).json({
        error:
          "El encargado no puede salir de la banda. Puedes deshabilitarla o eliminarla si no tiene historial.",
      });
    }

    const result = await pool.query(
      "DELETE FROM band_members WHERE band_id = $1 AND user_id = $2 RETURNING *",
      [id, userId],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "No eres miembro de esta banda" });
    }
    return res.json({ ok: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
};
