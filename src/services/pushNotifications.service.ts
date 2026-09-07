import axios from "axios";
import { pool } from "../lib/db";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

type PushData = Record<string, unknown>;

type SendPushToUsersOptions = {
  userIds: number[];
  title: string;
  body: string;
  data?: PushData;
};

type ExpoPushTicket = {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: {
    error?: string;
  };
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
}: SendPushToUsersOptions): Promise<void> {
  const uniqueUserIds = [...new Set(userIds)].filter(
    (id) => Number.isInteger(id) && id > 0,
  );

  if (uniqueUserIds.length === 0) {
    return;
  }

  try {
    const result = await pool.query(
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
      return;
    }

    const messages = devices.map((device) => ({
      to: device.expo_push_token,
      sound: "default",
      title,
      body,
      data,
    }));

    const response = await axios.post<{ data: ExpoPushTicket[] | ExpoPushTicket }>(
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

    tickets.forEach((ticket, index) => {
      if (ticket.status === "ok") {
        return;
      }

      console.error("Expo rechazó una notificación push:", {
        userId: devices[index]?.user_id,
        message: ticket.message,
        error: ticket.details?.error,
      });

      if (
        ticket.details?.error === "DeviceNotRegistered" &&
        devices[index]?.id
      ) {
        invalidTokenIds.push(devices[index].id);
      }
    });

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
  } catch (error: any) {
    console.error(
      "Error al enviar notificaciones push:",
      error.response?.data ?? error.message ?? error,
    );
  }
}
