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

    await client.query(
      `INSERT INTO band_member_periods (band_id, user_id, joined_at)
   VALUES ($1, $2, NOW())`,
      [band.id, userId],
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

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const bandResult = await client.query(
      `SELECT *
       FROM bands
       WHERE invite_code = $1
         AND archived_at IS NULL
       FOR UPDATE`,
      [String(invite_code).trim().toUpperCase()],
    );

    if (bandResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Código de invitación inválido" });
    }

    const band = bandResult.rows[0];

    if (band.owner_id === userId) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ error: "Ya eres el encargado de esta banda" });
    }

    const existing = await client.query(
      `SELECT id
       FROM band_members
       WHERE band_id = $1
         AND user_id = $2`,
      [band.id, userId],
    );

    if (existing.rowCount! > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Ya eres miembro de esta banda" });
    }

    await client.query(
      `INSERT INTO band_members (band_id, user_id, role)
       VALUES ($1, $2, $3)`,
      [band.id, userId, "musician"],
    );

    await client.query(
      `INSERT INTO band_member_periods (band_id, user_id, joined_at)
       VALUES ($1, $2, NOW())`,
      [band.id, userId],
    );

    await client.query("COMMIT");

    return res.json({ ok: true, data: band });
  } catch (error: any) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: error.message });
  } finally {
    client.release();
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

export const getMemberPeriods = async (req: AuthRequest, res: Response) => {
  const bandId = Number(req.params.id);
  const memberUserId = Number(req.params.userId);
  const requesterId = req.user!.id;

  if (!Number.isInteger(bandId) || bandId <= 0) {
    return res.status(400).json({
      error: "Banda inválida",
    });
  }

  if (!Number.isInteger(memberUserId) || memberUserId <= 0) {
    return res.status(400).json({
      error: "Usuario inválido",
    });
  }

  try {
    const bandResult = await pool.query(
      `SELECT id, owner_id
       FROM bands
       WHERE id = $1`,
      [bandId],
    );

    if (bandResult.rowCount === 0) {
      return res.status(404).json({
        error: "Banda no encontrada",
      });
    }

    const band = bandResult.rows[0];

    const isOwner = Number(band.owner_id) === requesterId;
    const isSelf = memberUserId === requesterId;

    if (!isOwner && !isSelf) {
      return res.status(403).json({
        error: "No tienes permiso para consultar estos periodos",
      });
    }

    const periodsResult = await pool.query(
      `SELECT
         bmp.id,
         bmp.band_id,
         bmp.user_id,
         bmp.joined_at,
         bmp.left_at,
         bmp.created_at
       FROM band_member_periods bmp
       WHERE bmp.band_id = $1
         AND bmp.user_id = $2
       ORDER BY bmp.joined_at ASC`,
      [bandId, memberUserId],
    );

    if (periodsResult.rowCount === 0) {
      return res.status(404).json({
        error: "No se encontraron periodos para este integrante",
      });
    }

    return res.json({
      ok: true,
      data: periodsResult.rows,
    });
  } catch (error: any) {
    return res.status(500).json({
      error: error.message,
    });
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

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const bandResult = await client.query(
      "SELECT owner_id FROM bands WHERE id = $1",
      [id],
    );

    if (bandResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Banda no encontrada" });
    }

    if (bandResult.rows[0].owner_id === userId) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error:
          "El encargado no puede salir de la banda. Puedes deshabilitarla o eliminarla si no tiene historial.",
      });
    }

    const membershipResult = await client.query(
      `SELECT id
       FROM band_members
       WHERE band_id = $1
         AND user_id = $2
       FOR UPDATE`,
      [id, userId],
    );

    if (membershipResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "No eres miembro de esta banda" });
    }

    const periodResult = await client.query(
      `UPDATE band_member_periods
       SET left_at = NOW()
       WHERE band_id = $1
         AND user_id = $2
         AND left_at IS NULL
       RETURNING id`,
      [id, userId],
    );

    if (periodResult.rowCount !== 1) {
      throw new Error(
        "No se encontró un periodo activo válido para esta membresía",
      );
    }

    await client.query(
      `DELETE FROM band_members
       WHERE band_id = $1
         AND user_id = $2`,
      [id, userId],
    );

    await client.query("COMMIT");

    return res.json({ ok: true });
  } catch (error: any) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
};

export const updateMemberPeriod = async (req: AuthRequest, res: Response) => {
  const bandId = Number(req.params.id);
  const memberUserId = Number(req.params.userId);
  const periodId = Number(req.params.periodId);
  const requesterId = req.user!.id;

  const { joined_at, left_at } = req.body;

  if (!Number.isInteger(bandId) || bandId <= 0) {
    return res.status(400).json({ error: "Banda inválida" });
  }

  if (!Number.isInteger(memberUserId) || memberUserId <= 0) {
    return res.status(400).json({ error: "Usuario inválido" });
  }

  if (!Number.isInteger(periodId) || periodId <= 0) {
    return res.status(400).json({ error: "Periodo inválido" });
  }

  const parsedJoinedAt = new Date(joined_at);

  if (Number.isNaN(parsedJoinedAt.getTime())) {
    return res.status(400).json({
      error: "La fecha de entrada no es válida",
    });
  }

  const parsedLeftAt =
    left_at === null || left_at === undefined || left_at === ""
      ? null
      : new Date(left_at);

  if (parsedLeftAt && Number.isNaN(parsedLeftAt.getTime())) {
    return res.status(400).json({
      error: "La fecha de salida no es válida",
    });
  }

  if (parsedLeftAt && parsedLeftAt < parsedJoinedAt) {
    return res.status(400).json({
      error: "La fecha de salida no puede ser anterior a la fecha de entrada",
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const bandResult = await client.query(
      `SELECT id, owner_id
       FROM bands
       WHERE id = $1
       FOR UPDATE`,
      [bandId],
    );

    if (bandResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: "Banda no encontrada",
      });
    }

    if (Number(bandResult.rows[0].owner_id) !== requesterId) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        error: "Solo el encargado puede modificar periodos",
      });
    }

    const periodResult = await client.query(
      `SELECT id, band_id, user_id, joined_at, left_at
       FROM band_member_periods
       WHERE id = $1
         AND band_id = $2
         AND user_id = $3
       FOR UPDATE`,
      [periodId, bandId, memberUserId],
    );

    if (periodResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: "Periodo no encontrado",
      });
    }

    const currentPeriod = periodResult.rows[0];

    const currentMembershipResult = await client.query(
      `SELECT id
   FROM band_members
   WHERE band_id = $1
     AND user_id = $2
   LIMIT 1`,
      [bandId, memberUserId],
    );

    const isCurrentMember = (currentMembershipResult.rowCount ?? 0) > 0;
    const isCurrentOpenPeriod = currentPeriod.left_at === null;

    if (isCurrentMember && isCurrentOpenPeriod && parsedLeftAt !== null) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        error:
          "No puedes cerrar el periodo activo mientras el integrante siga perteneciendo a la banda",
      });
    }

    if (!isCurrentMember && parsedLeftAt === null) {
      await client.query("ROLLBACK");

      return res.status(409).json({
        error:
          "No puedes dejar un periodo abierto para un integrante que ya no pertenece a la banda",
      });
    }

    const overlapResult = await client.query(
      `SELECT id
   FROM band_member_periods
   WHERE band_id = $1
     AND user_id = $2
     AND id <> $3
     AND joined_at <= COALESCE($5::timestamptz, 'infinity'::timestamptz)
     AND COALESCE(left_at, 'infinity'::timestamptz) >= $4::timestamptz
   LIMIT 1`,
      [
        bandId,
        memberUserId,
        periodId,
        parsedJoinedAt.toISOString(),
        parsedLeftAt?.toISOString() ?? null,
      ],
    );

    if ((overlapResult.rowCount ?? 0) > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "El periodo se empalma con otro periodo del integrante",
      });
    }

    const affectedGigs = await client.query(
      `SELECT g.id, g.title, g.date, g.time
   FROM gigs g
   WHERE g.band_id = $1
     AND (g.date + g.time) >= ($2::timestamptz AT TIME ZONE 'UTC')
     AND (
       $3::timestamptz IS NULL
       OR (g.date + g.time) <= ($3::timestamptz AT TIME ZONE 'UTC')
     )
     AND NOT (
       (g.date + g.time) >= ($4::timestamptz AT TIME ZONE 'UTC')
       AND (
         $5::timestamptz IS NULL
         OR (g.date + g.time) <= ($5::timestamptz AT TIME ZONE 'UTC')
       )
     )`,
      [
        bandId,
        currentPeriod.joined_at,
        currentPeriod.left_at,
        parsedJoinedAt.toISOString(),
        parsedLeftAt?.toISOString() ?? null,
      ],
    );

    for (const gig of affectedGigs.rows) {
      const historyResult = await client.query(
        `SELECT
           EXISTS (
             SELECT 1
             FROM gig_earnings ge
             WHERE ge.gig_id = $1
               AND ge.user_id = $2
           ) AS has_earnings,

           EXISTS (
             SELECT 1
             FROM gig_attendance ga
             WHERE ga.gig_id = $1
               AND ga.user_id = $2
           ) AS has_attendance,

           EXISTS (
             SELECT 1
             FROM financial_movements fm
             WHERE fm.gig_id = $1
               AND fm.user_id = $2
           ) AS has_financial_movements`,
        [gig.id, memberUserId],
      );

      const history = historyResult.rows[0];

      if (
        history.has_earnings ||
        history.has_attendance ||
        history.has_financial_movements
      ) {
        await client.query("ROLLBACK");

        return res.status(409).json({
          error:
            "No puedes modificar este periodo porque dejaría fuera una tocada con historial registrado",
          gig: {
            id: gig.id,
            title: gig.title,
            date: gig.date,
            time: gig.time,
          },
        });
      }
    }

    const updatedResult = await client.query(
      `UPDATE band_member_periods
       SET joined_at = $1,
           left_at = $2
       WHERE id = $3
       RETURNING *`,
      [
        parsedJoinedAt.toISOString(),
        parsedLeftAt?.toISOString() ?? null,
        periodId,
      ],
    );

    await client.query("COMMIT");

    return res.json({
      ok: true,
      data: updatedResult.rows[0],
    });
  } catch (error: any) {
    await client.query("ROLLBACK");

    return res.status(500).json({
      error: error.message,
    });
  } finally {
    client.release();
  }
};
