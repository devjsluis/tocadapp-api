import type { PoolClient } from "pg";

export const deleteUserPersonalData = async (
  client: PoolClient,
  userId: number,
) => {
  // La cuenta eliminada no debe conservar ningún acceso local.
  // Los pagos históricos NO se eliminan.
  await client.query(
    `
      UPDATE subscriptions
      SET
        status = CASE
          WHEN status = 'CANCELED' THEN status
          ELSE 'CANCELED'
        END,
        cancel_at_period_end = FALSE,
        canceled_at = COALESCE(canceled_at, NOW()),
        ended_at = COALESCE(ended_at, NOW())
      WHERE user_id = $1
        AND status IN ('PENDING', 'ACTIVE', 'PAST_DUE')
    `,
    [userId],
  );

  // Las bandas propias se conservan como historial compartido,
  // pero dejan de estar activas cuando desaparece su encargado.
  await client.query(
    `
      UPDATE bands
      SET archived_at = COALESCE(archived_at, NOW())
      WHERE owner_id = $1
    `,
    [userId],
  );

  // Datos financieros personales.
  // Los pagos de suscripción se conservan como historial financiero
  // y se gestionan por separado.
  await client.query(
    `
      DELETE FROM financial_movements
      WHERE user_id = $1
    `,
    [userId],
  );

  await client.query(
    `
      DELETE FROM expenses
      WHERE user_id = $1
    `,
    [userId],
  );

  // Conservamos las tocadas asociadas a bandas propiedad del usuario:
  // forman parte del historial compartido de la banda.
  //
  // Las tocadas personales sí desaparecen con la cuenta.
  await client.query(
    `
      DELETE FROM gigs
      WHERE user_id = $1
        AND band_id IS NULL
    `,
    [userId],
  );

  // Conservamos earnings y asistencia cuando pertenecen al historial
  // compartido de una banda. Solo eliminamos participación asociada
  // a tocadas personales o sin una banda existente.
  await client.query(
    `
      DELETE FROM gig_earnings ge
      WHERE ge.user_id = $1
        AND NOT EXISTS (
          SELECT 1
          FROM gigs g
          WHERE g.id = ge.gig_id
            AND g.band_id IS NOT NULL
        )
    `,
    [userId],
  );

  await client.query(
    `
      DELETE FROM gig_attendance ga
      WHERE ga.user_id = $1
        AND NOT EXISTS (
          SELECT 1
          FROM gigs g
          WHERE g.id = ga.gig_id
            AND g.band_id IS NOT NULL
        )
    `,
    [userId],
  );

  // Las entregas de notificaciones son datos operativos, no historial.
  await client.query(
    `
      DELETE FROM gig_notification_deliveries
      WHERE user_id = $1
    `,
    [userId],
  );

  // Solicitudes personales.
  await client.query(
    `
      DELETE FROM band_join_requests
      WHERE user_id = $1
    `,
    [userId],
  );

  // Si resolvió solicitudes de terceros, conservamos esas solicitudes
  // sin identificar al antiguo usuario.
  await client.query(
    `
      UPDATE band_join_requests
      SET resolved_by = NULL
      WHERE resolved_by = $1
    `,
    [userId],
  );

  // Si pertenece a bandas ajenas, deja de ser miembro.
  // En bandas propias conservamos la relación histórica de leader,
  // porque la banda y su historial continúan existiendo.
  await client.query(
    `
      DELETE FROM band_members bm
      WHERE bm.user_id = $1
        AND NOT EXISTS (
          SELECT 1
          FROM bands b
          WHERE b.id = bm.band_id
            AND b.owner_id = $1
        )
    `,
    [userId],
  );

  // En bandas propias conservamos el periodo histórico, pero lo
  // cerramos para que el usuario eliminado no aparezca activo eternamente.
  await client.query(
    `
      UPDATE band_member_periods bmp
      SET left_at = NOW()
      WHERE bmp.user_id = $1
        AND bmp.left_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM bands b
          WHERE b.id = bmp.band_id
            AND b.owner_id = $1
        )
    `,
    [userId],
  );

  // En bandas ajenas eliminamos sus periodos personales.
  await client.query(
    `
      DELETE FROM band_member_periods bmp
      WHERE bmp.user_id = $1
        AND NOT EXISTS (
          SELECT 1
          FROM bands b
          WHERE b.id = bmp.band_id
            AND b.owner_id = $1
        )
    `,
    [userId],
  );

  await client.query(
    `
      DELETE FROM musicians
      WHERE user_id = $1
    `,
    [userId],
  );

  // Credenciales, verificaciones y dispositivos dejan de existir.
  await client.query(
    `
      DELETE FROM password_reset_tokens
      WHERE user_id = $1
    `,
    [userId],
  );

  await client.query(
    `
      DELETE FROM email_verification_tokens
      WHERE user_id = $1
    `,
    [userId],
  );

  await client.query(
    `
      DELETE FROM user_push_tokens
      WHERE user_id = $1
    `,
    [userId],
  );
};
