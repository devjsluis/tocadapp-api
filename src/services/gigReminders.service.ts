import { pool } from "../lib/db";
import { sendPushToUsers } from "./pushNotifications.service";

const APP_TIMEZONE =
  process.env.APP_TIMEZONE || "America/Mexico_City";

type ReminderRow = {
  gig_id: number;
  title: string;
  place: string | null;
  band_id: number | null;
  gig_date: string;
  gig_time: string;
  user_id: number;
};

type ReminderConfig = {
  notificationType: string;
  minutesBefore: number;
  title: string;
  buildBody: (gig: ReminderRow) => string;
};

const REMINDERS: ReminderConfig[] = [
  {
    notificationType: "gig_reminder_24h",
    minutesBefore: 24 * 60,
    title: "Tocada mañana",
    buildBody: (gig) => {
      const time = String(gig.gig_time).slice(0, 5);
      const place = gig.place ? ` en ${gig.place}` : "";

      return `"${gig.title}" es mañana a las ${time}${place}.`;
    },
  },
  {
    notificationType: "gig_reminder_2h",
    minutesBefore: 2 * 60,
    title: "Tocada en 2 horas",
    buildBody: (gig) => {
      const time = String(gig.gig_time).slice(0, 5);
      const place = gig.place ? ` en ${gig.place}` : "";

      return `"${gig.title}" comienza a las ${time}${place}.`;
    },
  },
];

let isRunning = false;

async function checkReminder(
  config: ReminderConfig,
): Promise<void> {
  const result = await pool.query<ReminderRow>(
    `
      WITH upcoming_gigs AS (
        SELECT
          g.id AS gig_id,
          g.title,
          g.place,
          g.band_id,
          g.user_id AS owner_user_id,
          TO_CHAR(g.date, 'YYYY-MM-DD') AS gig_date,
          TO_CHAR(g.time, 'HH24:MI:SS') AS gig_time
        FROM gigs g
        WHERE
          (g.date + g.time) >=
            (NOW() AT TIME ZONE $1)
            + (($2 - 5) * INTERVAL '1 minute')
          AND
          (g.date + g.time) <
            (NOW() AT TIME ZONE $1)
            + (($2 + 5) * INTERVAL '1 minute')
      ),
      recipients AS (
        SELECT DISTINCT
          ug.gig_id,
          ug.title,
          ug.place,
          ug.band_id,
          ug.gig_date,
          ug.gig_time,
          recipient.user_id
        FROM upcoming_gigs ug
        CROSS JOIN LATERAL (
          SELECT ug.owner_user_id AS user_id

          UNION

          SELECT bmp.user_id
          FROM band_member_periods bmp
          WHERE ug.band_id IS NOT NULL
            AND bmp.band_id = ug.band_id
            AND (
              ug.gig_date::date + ug.gig_time::time
            ) AT TIME ZONE $1 >= bmp.joined_at
            AND (
              bmp.left_at IS NULL
              OR (
                ug.gig_date::date + ug.gig_time::time
              ) AT TIME ZONE $1 <= bmp.left_at
            )
        ) recipient
      )
      SELECT r.*
      FROM recipients r
      WHERE EXISTS (
        SELECT 1
        FROM user_push_tokens upt
        WHERE upt.user_id = r.user_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM gig_notification_deliveries gnd
        WHERE gnd.gig_id = r.gig_id
          AND gnd.user_id = r.user_id
          AND gnd.notification_type = $3
          AND gnd.gig_date = r.gig_date::date
          AND gnd.gig_time = r.gig_time::time
      )
      ORDER BY r.gig_id, r.user_id
    `,
    [
      APP_TIMEZONE,
      config.minutesBefore,
      config.notificationType,
    ],
  );

  if (result.rows.length === 0) {
    return;
  }

  const remindersByGig = new Map<number, ReminderRow[]>();

  for (const row of result.rows) {
    const rows = remindersByGig.get(row.gig_id) ?? [];
    rows.push(row);
    remindersByGig.set(row.gig_id, rows);
  }

  for (const [gigId, rows] of remindersByGig.entries()) {
    const first = rows[0];

    const userIds = rows.map((row) =>
      Number(row.user_id),
    );

    try {
      const acceptedUserIds = await sendPushToUsers({
        userIds,
        title: config.title,
        body: config.buildBody(first),
        data: {
          type: config.notificationType,
          gigId,
          bandId: first.band_id,
        },
      });

      if (acceptedUserIds.size === 0) {
        console.error(
          `${config.notificationType} no fue aceptado por Expo para tocada ${gigId}`,
        );
        continue;
      }

      for (const row of rows) {
        if (!acceptedUserIds.has(Number(row.user_id))) {
          continue;
        }
        await pool.query(
          `
            INSERT INTO gig_notification_deliveries (
              gig_id,
              user_id,
              notification_type,
              gig_date,
              gig_time
            )
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT DO NOTHING
          `,
          [
            row.gig_id,
            row.user_id,
            config.notificationType,
            row.gig_date,
            row.gig_time,
          ],
        );
      }

      console.log(
        `${config.notificationType} aceptado por Expo para tocada ${gigId} a ${acceptedUserIds.size} usuario(s)`,
      );
    } catch (error) {
      console.error(
        `Error enviando ${config.notificationType} de tocada ${gigId}:`,
        error,
      );
    }
  }
}


async function checkPendingPayments(): Promise<void> {
  const notificationType = "gig_payment_pending";

  const result = await pool.query<ReminderRow>(
    `
      WITH yesterday_gigs AS (
        SELECT
          g.id AS gig_id,
          g.title,
          g.place,
          g.band_id,
          g.user_id AS owner_user_id,
          g.collected_amount AS owner_collected_amount,
          TO_CHAR(g.date, 'YYYY-MM-DD') AS gig_date,
          TO_CHAR(g.time, 'HH24:MI:SS') AS gig_time
        FROM gigs g
        WHERE g.date = (
          (NOW() AT TIME ZONE $1)::date - INTERVAL '1 day'
        )::date
          AND (NOW() AT TIME ZONE $1)::time >= TIME '10:00'
          AND (NOW() AT TIME ZONE $1)::time < TIME '10:10'
      ),
      recipients AS (
        SELECT DISTINCT
          yg.gig_id,
          yg.title,
          yg.place,
          yg.band_id,
          yg.gig_date,
          yg.gig_time,
          recipient.user_id,
          recipient.collected_amount
        FROM yesterday_gigs yg
        CROSS JOIN LATERAL (
          SELECT
            yg.owner_user_id AS user_id,
            yg.owner_collected_amount AS collected_amount

          UNION ALL

          SELECT
            bmp.user_id,
            ge.collected_amount
          FROM band_member_periods bmp
          LEFT JOIN gig_earnings ge
            ON ge.gig_id = yg.gig_id
           AND ge.user_id = bmp.user_id
          WHERE yg.band_id IS NOT NULL
            AND bmp.band_id = yg.band_id
            AND bmp.user_id <> yg.owner_user_id
            AND (
              yg.gig_date::date + yg.gig_time::time
            ) AT TIME ZONE $1 >= bmp.joined_at
            AND (
              bmp.left_at IS NULL
              OR (
                yg.gig_date::date + yg.gig_time::time
              ) AT TIME ZONE $1 <= bmp.left_at
            )
        ) recipient
      )
      SELECT r.*
      FROM recipients r
      WHERE r.collected_amount IS NULL
        AND EXISTS (
          SELECT 1
          FROM user_push_tokens upt
          WHERE upt.user_id = r.user_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM gig_notification_deliveries gnd
          WHERE gnd.gig_id = r.gig_id
            AND gnd.user_id = r.user_id
            AND gnd.notification_type = $2
            AND gnd.gig_date = r.gig_date::date
            AND gnd.gig_time = r.gig_time::time
        )
      ORDER BY r.gig_id, r.user_id
    `,
    [APP_TIMEZONE, notificationType],
  );

  for (const row of result.rows) {
    try {
      const acceptedUserIds = await sendPushToUsers({
        userIds: [Number(row.user_id)],
        title: "Cobro pendiente",
        body: `Aún no has registrado el cobro de "${row.title}".`,
        data: {
          type: notificationType,
          gigId: row.gig_id,
          bandId: row.band_id,
        },
      });

      if (!acceptedUserIds.has(Number(row.user_id))) {
        console.error(
          `${notificationType} no fue aceptado por Expo para tocada ${row.gig_id} y usuario ${row.user_id}`,
        );
        continue;
      }

      await pool.query(
        `
          INSERT INTO gig_notification_deliveries (
            gig_id,
            user_id,
            notification_type,
            gig_date,
            gig_time
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT DO NOTHING
        `,
        [
          row.gig_id,
          row.user_id,
          notificationType,
          row.gig_date,
          row.gig_time,
        ],
      );

      console.log(
        `${notificationType} enviado para tocada ${row.gig_id} al usuario ${row.user_id}`,
      );
    } catch (error) {
      console.error(
        `Error enviando ${notificationType} de tocada ${row.gig_id} al usuario ${row.user_id}:`,
        error,
      );
    }
  }
}

export async function checkGigReminders(): Promise<void> {
  if (isRunning) {
    return;
  }

  isRunning = true;

  try {
    for (const reminder of REMINDERS) {
      await checkReminder(reminder);
    }

    await checkPendingPayments();
  } catch (error) {
    console.error(
      "Error al revisar recordatorios de tocadas:",
      error,
    );
  } finally {
    isRunning = false;
  }
}
