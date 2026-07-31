import axios from "axios";
import { createHash, randomBytes } from "crypto";
import type { PoolClient } from "pg";

import { pool } from "../lib/db";

const VERIFICATION_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

const hashToken = (token: string): string => {
  return createHash("sha256").update(token).digest("hex");
};

type VerificationUser = {
  id: number;
  email: string;
  name: string;
  email_verified_at: Date | null;
};

const sendVerificationEmail = async (
  email: string,
  name: string,
  rawToken: string,
) => {
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";

  const verificationLink = `${frontendUrl}/verify-email?token=${encodeURIComponent(rawToken)}`;

  await axios.post(
    "https://api.brevo.com/v3/smtp/email",
    {
      sender: {
        email: process.env.EMAIL_FROM_ADDRESS,
        name: "TocadApp",
      },
      to: [{ email, name }],
      subject: "Confirma tu correo electrónico - TocadApp",
      htmlContent: `
        <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; background: #09090b; color: #ffffff; border: 1px solid #27272a; border-radius: 16px; padding: 40px;">
          <h2 style="margin-top: 0; color: #a855f7;">
            Confirma tu correo
          </h2>

          <p style="color: #a1a1aa;">
            Hola <strong style="color: #ffffff;">${name}</strong>,
          </p>

          <p style="color: #a1a1aa; line-height: 1.6;">
            Confirma que este correo te pertenece para activar tu cuenta de TocadApp.
          </p>

          <p style="margin: 32px 0; text-align: center;">
            <a
              href="${verificationLink}"
              style="display: inline-block; background: #7e22ce; color: #ffffff; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: bold;"
            >
              Confirmar correo
            </a>
          </p>

          <p style="color: #71717a; font-size: 13px; line-height: 1.5;">
            El enlace vence en 24 horas. Si no creaste esta cuenta, puedes ignorar este correo.
          </p>

          <hr style="margin: 24px 0; border: 0; border-top: 1px solid #27272a;" />

          <p style="margin: 0; color: #52525b; font-size: 12px;">
            TocadApp · La aplicación para músicos
          </p>
        </div>
      `,
    },
    {
      headers: {
        "api-key": process.env.BREVO_API_KEY,
        "Content-Type": "application/json",
      },
    },
  );
};

const createTokenWithClient = async (
  client: PoolClient,
  userId: number,
): Promise<string> => {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_LIFETIME_MS);

  await client.query(
    `
      UPDATE email_verification_tokens
      SET used = TRUE
      WHERE user_id = $1
        AND used = FALSE
    `,
    [userId],
  );

  await client.query(
    `
      INSERT INTO email_verification_tokens (
        user_id,
        token_hash,
        expires_at
      )
      VALUES ($1, $2, $3)
    `,
    [userId, tokenHash, expiresAt],
  );

  return rawToken;
};

export const createEmailVerificationToken = async (
  client: PoolClient,
  userId: number,
): Promise<string> => {
  return createTokenWithClient(client, userId);
};

export const sendEmailVerification = async (
  email: string,
  name: string,
  rawToken: string,
): Promise<void> => {
  await sendVerificationEmail(email, name, rawToken);
};

export const resendVerificationEmail = async (email: string): Promise<void> => {
  const normalizedEmail = email.trim().toLowerCase();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const userResult = await client.query<VerificationUser>(
      `
        SELECT
          id,
          email,
          name,
          email_verified_at
        FROM users
        WHERE LOWER(email) = LOWER($1)
        LIMIT 1
        FOR UPDATE
      `,
      [normalizedEmail],
    );

    const user = userResult.rows[0];

    // Se responde igual aunque el usuario no exista para no revelar cuentas.
    if (!user || user.email_verified_at) {
      await client.query("COMMIT");
      return;
    }

    const rawToken = await createTokenWithClient(client, user.id);

    await client.query("COMMIT");

    await sendVerificationEmail(user.email, user.name, rawToken);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const verifyEmailToken = async (rawToken: string): Promise<void> => {
  const tokenHash = hashToken(rawToken);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const tokenResult = await client.query(
      `
        SELECT
          evt.id,
          evt.user_id,
          evt.expires_at,
          evt.used,
          u.email_verified_at
        FROM email_verification_tokens evt
        JOIN users u
          ON u.id = evt.user_id
        WHERE evt.token_hash = $1
        LIMIT 1
        FOR UPDATE
      `,
      [tokenHash],
    );

    if (tokenResult.rowCount === 0) {
      throw new Error("VERIFICATION_TOKEN_INVALID");
    }

    const verificationToken = tokenResult.rows[0];

    if (verificationToken.email_verified_at) {
      await client.query(
        `
          UPDATE email_verification_tokens
          SET used = TRUE
          WHERE id = $1
        `,
        [verificationToken.id],
      );

      await client.query("COMMIT");
      return;
    }

    if (verificationToken.used) {
      throw new Error("VERIFICATION_TOKEN_USED");
    }

    if (new Date(verificationToken.expires_at).getTime() < Date.now()) {
      throw new Error("VERIFICATION_TOKEN_EXPIRED");
    }

    await client.query(
      `
        UPDATE users
        SET email_verified_at = NOW()
        WHERE id = $1
      `,
      [verificationToken.user_id],
    );

    await client.query(
      `
        UPDATE email_verification_tokens
        SET used = TRUE
        WHERE user_id = $1
      `,
      [verificationToken.user_id],
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};
