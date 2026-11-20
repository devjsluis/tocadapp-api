import { createHash } from "node:crypto";
import { GoogleAuth } from "google-auth-library";
import { pool } from "../lib/db";

const MAX_REPORT_BYTES = 10 * 1024 * 1024;
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/devstorage.read_only"] });

export async function importGooglePlayAccountingReports(now = new Date()) {
  const bucket = process.env.ACCOUNTING_GOOGLE_PLAY_BUCKET;
  if (!bucket) return;

  const adminId = Number(process.env.ACCOUNTING_GOOGLE_PLAY_UPLOADER_ID);
  if (!/^pubsite_prod_rev_\d+$/.test(bucket) || !Number.isSafeInteger(adminId) || adminId < 1) {
    throw new Error("Invalid Google Play accounting configuration");
  }

  const google = await auth.getClient();
  const months = [2, 1].map(offset =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1)).toISOString().slice(0, 7),
  );

  for (const month of months) {
    const filename = `earnings_${month.replace("-", "")}.zip`;
    const object = encodeURIComponent(`earnings/${filename}`);
    const { data, status } = await google.request<ArrayBuffer>({
      url: `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${object}?alt=media`,
      responseType: "arraybuffer",
      validateStatus: status => status === 200 || status === 404,
      maxContentLength: MAX_REPORT_BYTES,
      timeout: 30_000,
    });
    if (status === 404) continue;

    const content = Buffer.from(data);
    if (content.length < 22 || content.length > MAX_REPORT_BYTES || content.readUInt32LE(0) !== 0x04034b50) {
      throw new Error("Invalid Google Play earnings archive");
    }
    const sha256 = createHash("sha256").update(content).digest("hex");

    await pool.query(`
      WITH imported AS (
        INSERT INTO accounting_documents (month, kind, filename, content_type, content, sha256, uploaded_by)
        VALUES ($1::date, 'GOOGLE_PLAY', $2, 'application/zip', $3, $4, $5)
        ON CONFLICT (month, sha256) DO NOTHING
        RETURNING id
      )
      INSERT INTO accounting_audit_log (actor_kind, action, month, details)
      SELECT 'ANONYMOUS', 'IMPORT_GOOGLE_PLAY_REPORT', $1::date, jsonb_build_object('documentId', id)
      FROM imported
    `, [`${month}-01`, filename, content, sha256, adminId]);
  }
}
