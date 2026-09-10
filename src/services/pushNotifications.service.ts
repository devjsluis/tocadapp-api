import axios from "axios";
import { pool } from "../lib/db";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL =
  "https://exp.host/--/api/v2/push/getReceipts";

type PushData = Record<string, unknown>;

type SendPushToUsersOptions = {
  userIds: number[];
  title: string;
  body: string;
  data?: PushData;
};

type PushTokenRow = {
  id: number;
  user_id: number;
  expo_push_token: string;
};

type ExpoPushTicket = {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: {
    error?: string;
  };
};

type ExpoPushReceipt = {
  status: "ok" | "error";
  message?: string;
  details?: {
    error?: string;
  };
};

type PendingReceiptRow = {
  ticket_id: string;
  push_token_id: number;
  expo_push_token: string;
  user_id: number;
};

function isExpoPushToken(token: string): boolean {
  return (
    token.startsWith("ExponentPushToken[") ||
    token.startsWith("ExpoPushToken[")
  );
}

export async function sendPushToUsers({
  userIds,
  title,
  body,
  data = {},
}: SendPushToUsersOptions): Promise<Set<number>> {
  const uniqueUserIds = [...new Set(userIds)].filter(
    (id) => Number.isInteger(id) && id > 0,
  );

  if (uniqueUserIds.length === 0) {
    return new Set<number>();
  }

  try {
    const result = await pool.query<PushTokenRow>(
      `
        SELECT id, user_id, expo_push_token
        FROM user_push_tokens
        WHERE user_id = ANY($1::int[])
      `,
      [uniqueUserIds],
    );

    const devices = result.rows.filter((row) =>
      isExpoPushToken(row.expo_push_token),
    );

    if (devices.length === 0) {
      return new Set<number>();
    }

    const messages = devices.map((device) => ({
      to: device.expo_push_token,
      sound: "default",
      title,
      body,
      data,
    }));

    const response = await axios.post<{
      data: ExpoPushTicket[] | ExpoPushTicket;
    }>(
      EXPO_PUSH_URL,
      messages,
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        timeout: 10000,
      },
    );

    const tickets = Array.isArray(response.data.data)
      ? response.data.data
      : [response.data.data];

    const invalidTokenIds: number[] = [];
    const acceptedUserIds = new Set<number>();

    for (let index = 0; index < tickets.length; index += 1) {
      const ticket = tickets[index];
      const device = devices[index];

      if (!device) {
        continue;
      }

      if (ticket.status === "ok" && ticket.id) {
        acceptedUserIds.add(device.user_id);

        await pool.query(
          `
            INSERT INTO push_notification_receipts (
              ticket_id,
              push_token_id
            )
            VALUES ($1, $2)
            ON CONFLICT (ticket_id) DO NOTHING
          `,
          [ticket.id, device.id],
        );

        continue;
      }

      console.error("Expo rechazó una notificación push:", {
        userId: device.user_id,
        message: ticket.message,
        error: ticket.details?.error,
      });

      if (ticket.details?.error === "DeviceNotRegistered") {
        invalidTokenIds.push(device.id);
      }
    }

    if (invalidTokenIds.length > 0) {
      await pool.query(
        `
          DELETE FROM user_push_tokens
          WHERE id = ANY($1::bigint[])
        `,
        [invalidTokenIds],
      );

      console.log(
        `Push tokens inválidos eliminados: ${invalidTokenIds.length}`,
      );
    }

    return acceptedUserIds;
  } catch (error: any) {
    console.error(
      "Error al enviar notificaciones push:",
      error.response?.data ?? error.message ?? error,
    );

    return new Set<number>();
  }
}

let isCheckingReceipts = false;

export async function checkPushReceipts(): Promise<void> {
  if (isCheckingReceipts) {
    return;
  }

  isCheckingReceipts = true;

  try {
    /*
     * Expo recomienda esperar aproximadamente 15 minutos antes de
     * consultar los receipts. También los elimina después de 24 horas.
     */
    const result = await pool.query<PendingReceiptRow>(
      `
        SELECT
          pnr.ticket_id,
          pnr.push_token_id,
          upt.expo_push_token,
          upt.user_id
        FROM push_notification_receipts pnr
        INNER JOIN user_push_tokens upt
          ON upt.id = pnr.push_token_id
        WHERE pnr.created_at <= NOW() - INTERVAL '15 minutes'
          AND pnr.created_at > NOW() - INTERVAL '24 hours'
        ORDER BY pnr.created_at ASC
        LIMIT 1000
      `,
    );

    if (result.rows.length > 0) {
      const ids = result.rows.map((row) => row.ticket_id);

      const response = await axios.post<{
        data?: Record<string, ExpoPushReceipt>;
      }>(
        EXPO_RECEIPTS_URL,
        { ids },
        {
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          timeout: 10000,
        },
      );

      const receipts: Record<string, ExpoPushReceipt> =
        response.data.data ?? {};

      for (const row of result.rows) {
        const receipt = receipts[row.ticket_id];

        /*
         * Si Expo todavía no tiene el receipt, lo dejamos pendiente
         * para revisarlo en la siguiente ejecución.
         */
        if (!receipt) {
          continue;
        }

        if (receipt.status === "error") {
          console.error("Expo reportó error en push receipt:", {
            ticketId: row.ticket_id,
            userId: row.user_id,
            message: receipt.message,
            error: receipt.details?.error,
          });

          if (receipt.details?.error === "DeviceNotRegistered") {
            await pool.query(
              `
                DELETE FROM user_push_tokens
                WHERE id = $1
              `,
              [row.push_token_id],
            );

            console.log(
              `Push token inválido eliminado por receipt para usuario ${row.user_id}`,
            );

            /*
             * ON DELETE CASCADE elimina también el receipt.
             */
            continue;
          }
        }

        /*
         * El receipt ya fue resuelto. Sea OK o un error definitivo
         * distinto de DeviceNotRegistered, ya no necesitamos consultarlo.
         */
        await pool.query(
          `
            DELETE FROM push_notification_receipts
            WHERE ticket_id = $1
          `,
          [row.ticket_id],
        );
      }
    }

    /*
     * Expo conserva receipts solamente durante aproximadamente 24 horas.
     * Cualquier ticket más antiguo ya no tiene utilidad.
     */
    const cleanup = await pool.query(
      `
        DELETE FROM push_notification_receipts
        WHERE created_at <= NOW() - INTERVAL '24 hours'
      `,
    );

    if ((cleanup.rowCount ?? 0) > 0) {
      console.log(
        `Push receipts expirados eliminados: ${cleanup.rowCount}`,
      );
    }
  } catch (error: any) {
    console.error(
      "Error al consultar Expo push receipts:",
      error.response?.data ?? error.message ?? error,
    );
  } finally {
    isCheckingReceipts = false;
  }
}
