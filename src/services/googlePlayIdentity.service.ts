import { query } from "../lib/db";

// Issued by the server; never derive ownership from client-provided account IDs.
export const getGooglePlayBillingIdentity = async (userId: number) => {
  const result = await query<{ obfuscated_account_id: string }>(
    `SELECT i.obfuscated_account_id
     FROM google_play_billing_identities i JOIN users u ON u.id = i.user_id
     WHERE i.user_id = $1 AND u.deleted_at IS NULL`, [userId],
  );
  if (!result.rows[0]) throw new Error("USER_NOT_FOUND");
  return { obfuscatedAccountId: result.rows[0].obfuscated_account_id };
};

export type BillingIdentityReader = {
  query: (sql: string, args: unknown[]) => Promise<{ rows: { user_id: number }[] }>;
};

export const findGooglePlayBillingIdentityOwner = async (
  identity: string, db: BillingIdentityReader = { query },
): Promise<number | null> => {
  const result = await db.query(
    `SELECT user_id FROM google_play_billing_identities WHERE obfuscated_account_id = $1`,
    [identity],
  );
  return result.rows[0]?.user_id ?? null;
};
