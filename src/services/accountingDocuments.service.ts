import { createHash } from "node:crypto";
import { pool } from "../lib/db";
import { validAccountingMonth } from "./accountingReport.service";
import { auditAccounting } from "./accountingAuth.service";

const kinds = ["CFDI", "BANK", "APPLE", "GOOGLE_PLAY", "STRIPE_FEES", "OTHER"];
export function validateAccountingDocument(month: unknown, kind: unknown, filename: unknown, contentType: string, content: unknown) {
  if (!validAccountingMonth(month) || typeof kind !== "string" || !kinds.includes(kind) ||
    typeof filename !== "string" || !filename.trim() || filename.length > 180 || /[\x00-\x1f\x7f/\\]/.test(filename) ||
    !Buffer.isBuffer(content) || content.length === 0 || content.length > 10485760) throw Error("INVALID_DOCUMENT");
  const mime = contentType.split(";")[0].trim().toLowerCase();
  const lowerName = filename.toLowerCase();
  if (mime === "application/pdf") {
    if (!lowerName.endsWith(".pdf") || content.subarray(0, 5).toString() !== "%PDF-") throw Error("INVALID_DOCUMENT");
  } else if (["application/xml", "text/xml"].includes(mime)) {
    const xml = content.toString("utf8");
    if (!lowerName.endsWith(".xml") || !xml.trimStart().startsWith("<") || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw Error("INVALID_DOCUMENT");
  } else if (mime === "text/csv") {
    if (!lowerName.endsWith(".csv") || content.includes(0)) throw Error("INVALID_DOCUMENT");
  } else throw Error("INVALID_DOCUMENT");
  return { month, kind, filename: filename.trim(), mime, content, sha256: createHash("sha256").update(content).digest("hex") };
}
export async function uploadAccountingDocument(adminId: number, data: ReturnType<typeof validateAccountingDocument>) {
  const result = await pool.query(`INSERT INTO accounting_documents(month,kind,filename,content_type,content,sha256,uploaded_by)
    VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
  [data.month + "-01", data.kind, data.filename, data.mime, data.content, data.sha256, adminId]);
  await auditAccounting({ kind: "ADMIN", id: adminId }, "UPLOAD_DOCUMENT", data.month, { documentId: result.rows[0].id });
  return result.rows[0];
}
export async function downloadAccountingDocument(id: number) {
  const result = await pool.query<{ filename: string; content_type: string; content: Buffer; month: string }>(
    `SELECT filename,content_type,content,to_char(month,'YYYY-MM') AS month FROM accounting_documents WHERE id=$1`, [id]);
  if (!result.rows[0]) throw Error("DOCUMENT_NOT_FOUND");
  return result.rows[0];
}
export async function removeAccountingDocument(adminId: number, id: number) {
  const result = await pool.query("DELETE FROM accounting_documents WHERE id=$1 RETURNING to_char(month,'YYYY-MM') AS month", [id]);
  if (!result.rows[0]) throw Error("DOCUMENT_NOT_FOUND");
  await auditAccounting({ kind: "ADMIN", id: adminId }, "DELETE_DOCUMENT", result.rows[0].month, { documentId: id });
}
export function validateSettlement(data: Record<string, unknown>) {
  if (!validAccountingMonth(data.month) || !["APPLE", "GOOGLE_PLAY"].includes(String(data.provider)) ||
    typeof data.currency !== "string" || !/^[A-Z]{3}$/.test(data.currency) ||
    typeof data.documentId !== "number" || !Number.isSafeInteger(data.documentId) || data.documentId <= 0 ||
    typeof data.notes !== "string" || data.notes.length > 1000) throw Error("INVALID_SETTLEMENT");
  const amounts = [data.grossMinor, data.feesMinor, data.refundsMinor, data.withheldMinor, data.depositsMinor];
  if (amounts.some(value => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1000000000000)) throw Error("INVALID_SETTLEMENT");
  const net = Number(data.grossMinor) - Number(data.feesMinor) - Number(data.refundsMinor) - Number(data.withheldMinor);
  return { month: data.month, provider: String(data.provider), currency: data.currency, documentId: data.documentId,
    grossMinor: Number(data.grossMinor), feesMinor: Number(data.feesMinor), refundsMinor: Number(data.refundsMinor),
    withheldMinor: Number(data.withheldMinor), depositsMinor: Number(data.depositsMinor), netMinor: net, notes: data.notes };
}
export async function saveSettlement(adminId: number, data: ReturnType<typeof validateSettlement>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const document = await client.query("SELECT id FROM accounting_documents WHERE id=$1 AND month=$2 AND kind=$3 FOR SHARE",
      [data.documentId, data.month + "-01", data.provider]);
    if (!document.rowCount) throw Error("INVALID_SETTLEMENT_DOCUMENT");
    const result = await client.query(`INSERT INTO accounting_settlements(month,provider,currency,gross_minor,fees_minor,refunds_minor,withheld_minor,net_minor,deposits_minor,document_id,notes,confirmed_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT(month,provider,currency) DO UPDATE SET gross_minor=EXCLUDED.gross_minor,fees_minor=EXCLUDED.fees_minor,
      refunds_minor=EXCLUDED.refunds_minor,withheld_minor=EXCLUDED.withheld_minor,net_minor=EXCLUDED.net_minor,
      deposits_minor=EXCLUDED.deposits_minor,document_id=EXCLUDED.document_id,notes=EXCLUDED.notes,confirmed_by=EXCLUDED.confirmed_by,updated_at=NOW()
      RETURNING id`, [data.month + "-01", data.provider, data.currency, data.grossMinor, data.feesMinor, data.refundsMinor,
      data.withheldMinor, data.netMinor, data.depositsMinor, data.documentId, data.notes, adminId]);
    await client.query(`INSERT INTO accounting_audit_log(actor_kind,actor_id,action,month,details) VALUES('ADMIN',$1,'SAVE_SETTLEMENT',$2,$3)`,
      [adminId, data.month + "-01", JSON.stringify({ provider: data.provider, currency: data.currency, settlementId: result.rows[0].id })]);
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
