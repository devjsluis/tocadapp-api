import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcrypt";
import type { NextFunction, Request, Response } from "express";
import { pool } from "../lib/db";

export type AccountingActor = { kind: "ADMIN" | "ACCOUNTANT" | "ANONYMOUS"; id?: number };
export type Accountant = { id: number; username: string; displayName: string };
export interface AccountingRequest extends Request { accountant?: Accountant }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const accountingCookieName = () => process.env.NODE_ENV === "production"
  ? "__Host-tocadapp-accounting" : "tocadapp-accounting";
export const accountingCookieOptions = () => ({
  httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict" as const,
  path: "/", maxAge: 8 * 60 * 60 * 1000,
});
// A real bcrypt hash also gives unknown usernames the same password verification work.
const dummyHash = bcrypt.hashSync("accounting-unknown-" + randomBytes(24).toString("hex"), 12);

export async function auditAccounting(actor: AccountingActor, action: string, month?: string, details = {}) {
  await pool.query(`INSERT INTO accounting_audit_log(actor_kind,actor_id,action,month,details)
    VALUES($1,$2,$3,$4,$5)`, [actor.kind, actor.id ?? null, action, month ? month + "-01" : null, JSON.stringify(details)]);
}

export async function loginAccountant(username: unknown, password: unknown) {
  if (typeof username !== "string" || typeof password !== "string" || password.length > 128 ||
    !/^[a-z0-9._-]{3,64}$/.test(username.trim().toLowerCase())) return null;
  const normalized = username.trim().toLowerCase();
  const result = await pool.query<{ id: number; username: string; display_name: string; password_hash: string; active: boolean }>(
    "SELECT id,username,display_name,password_hash,active FROM accounting_accounts WHERE username=$1", [normalized]);
  const account = result.rows[0];
  const valid = await bcrypt.compare(password, account?.password_hash ?? dummyHash);
  if (!account?.active || !valid) {
    await auditAccounting({ kind: "ANONYMOUS" }, "LOGIN_FAILED", undefined, { usernameHash: hash(normalized) });
    return null;
  }
  const token = randomBytes(32).toString("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Revocation and login serialize on the account, preventing a session issued after revocation.
    const current = await client.query("SELECT id FROM accounting_accounts WHERE id=$1 AND password_hash=$2 AND active=TRUE FOR UPDATE", [account.id, account.password_hash]);
    if (!current.rowCount) { await client.query("ROLLBACK"); return null; }
    await client.query("DELETE FROM accounting_sessions WHERE expires_at <= NOW() OR account_id=$1", [account.id]);
    await client.query(`INSERT INTO accounting_sessions(token_hash,account_id,expires_at)
      VALUES($1,$2,NOW()+interval '8 hours')`, [hash(token), account.id]);
    await client.query(`INSERT INTO accounting_audit_log(actor_kind,actor_id,action)
      VALUES('ACCOUNTANT',$1,'LOGIN')`, [account.id]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  return { token, account: { id: account.id, username: account.username, displayName: account.display_name } };
}

export function accountingToken(req: Request): string | null {
  const cookie = req.headers.cookie?.split(";").map(part => part.trim()).find(part => part.startsWith(accountingCookieName() + "="));
  const token = cookie?.slice(accountingCookieName().length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}

export async function requireAccountant(req: AccountingRequest, res: Response, next: NextFunction) {
  const token = accountingToken(req);
  if (!token) { res.status(401).json({ error: "Inicia sesión en el portal del contador" }); return; }
  try {
    const result = await pool.query<{ id: number; username: string; display_name: string }>(
      `SELECT a.id,a.username,a.display_name FROM accounting_sessions s
       JOIN accounting_accounts a ON a.id=s.account_id
       WHERE s.token_hash=$1 AND s.expires_at>NOW() AND a.active=TRUE`, [hash(token)]);
    if (!result.rows[0]) { res.status(401).json({ error: "La sesión contable expiró o fue revocada" }); return; }
    const account = result.rows[0];
    req.accountant = { id: account.id, username: account.username, displayName: account.display_name };
    next();
  } catch { res.status(503).json({ error: "No fue posible verificar el acceso contable" }); }
}

export async function logoutAccountant(req: AccountingRequest) {
  const token = accountingToken(req);
  if (token) await pool.query("DELETE FROM accounting_sessions WHERE token_hash=$1", [hash(token)]);
  await auditAccounting({ kind: "ACCOUNTANT", id: req.accountant!.id }, "LOGOUT");
}

export async function listAccountants() {
  return (await pool.query("SELECT id,username,display_name AS \"displayName\",active,created_at AS \"createdAt\" FROM accounting_accounts ORDER BY created_at DESC")).rows;
}

export async function createAccountant(adminId: number, username: unknown, displayName: unknown) {
  if (typeof username !== "string" || !/^[a-z0-9._-]{3,64}$/.test(username.trim().toLowerCase()) ||
    typeof displayName !== "string" || !displayName.trim() || displayName.trim().length > 120) throw Error("INVALID_ACCOUNTANT");
  const password = randomBytes(24).toString("base64url");
  const result = await pool.query(`INSERT INTO accounting_accounts(username,display_name,password_hash,created_by)
    VALUES($1,$2,$3,$4) RETURNING id,username,display_name AS "displayName",active`,
  [username.trim().toLowerCase(), displayName.trim(), await bcrypt.hash(password, 12), adminId]);
  await auditAccounting({ kind: "ADMIN", id: adminId }, "CREATE_ACCOUNTANT", undefined, { accountantId: result.rows[0].id });
  return { account: result.rows[0], password };
}

export async function changeAccountant(adminId: number, id: number, rotate: boolean) {
  const password = rotate ? randomBytes(24).toString("base64url") : undefined;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = rotate
      ? await client.query("UPDATE accounting_accounts SET password_hash=$2,active=TRUE WHERE id=$1 RETURNING id", [id, await bcrypt.hash(password!, 12)])
      : await client.query("UPDATE accounting_accounts SET active=FALSE WHERE id=$1 RETURNING id", [id]);
    if (!updated.rowCount) throw Error("ACCOUNTANT_NOT_FOUND");
    await client.query("DELETE FROM accounting_sessions WHERE account_id=$1", [id]);
    await client.query(`INSERT INTO accounting_audit_log(actor_kind,actor_id,action,details)
      VALUES('ADMIN',$1,$2,$3)`, [adminId, rotate ? "ROTATE_ACCOUNTANT" : "REVOKE_ACCOUNTANT", JSON.stringify({ accountantId: id })]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  return { password };
}
