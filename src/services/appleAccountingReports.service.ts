import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import axios from "axios";
import jwt from "jsonwebtoken";
import { pool } from "../lib/db";

const MAX_REPORT_BYTES = 10 * 1024 * 1024;

export async function importAppleAccountingReports(now = new Date()) {
  const vendorNumber = process.env.ACCOUNTING_APPLE_VENDOR_NUMBER;
  if (!vendorNumber) return;

  const issuerId = process.env.ACCOUNTING_APPLE_ISSUER_ID;
  const keyId = process.env.ACCOUNTING_APPLE_KEY_ID;
  const keyPath = process.env.ACCOUNTING_APPLE_PRIVATE_KEY_PATH;
  const adminId = Number(process.env.ACCOUNTING_APPLE_UPLOADER_ID);
  if (!/^\d+$/.test(vendorNumber) || !issuerId || !keyId || !keyPath ||
      !Number.isSafeInteger(adminId) || adminId < 1) {
    throw new Error("Invalid Apple accounting configuration");
  }

  const key = await readFile(keyPath);
  const token = jwt.sign({}, key, {
    algorithm: "ES256", audience: "appstoreconnect-v1", issuer: issuerId, keyid: keyId, expiresIn: "5m",
  });
  // Request Apple's fiscal month labels directly. Never derive their day boundaries.
  const months = [1, 2].map(offset =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1)).toISOString().slice(0, 7),
  );

  for (const month of months) {
    const { data, status } = await axios.get<ArrayBuffer>("https://api.appstoreconnect.apple.com/v1/financeReports", {
      params: {
        "filter[vendorNumber]": vendorNumber,
        "filter[reportDate]": month,
        "filter[reportType]": "FINANCIAL",
        "filter[regionCode]": "ZZ",
      },
      headers: { Authorization: `Bearer ${token}`, Accept: "application/a-gzip" },
      responseType: "arraybuffer",
      decompress: false,
      maxRedirects: 0,
      maxContentLength: MAX_REPORT_BYTES,
      validateStatus: status => status === 200 || status === 404,
      timeout: 30_000,
    });
    if (status === 404) continue;

    const content = Buffer.from(data);
    if (content.length < 18 || content.length > MAX_REPORT_BYTES ||
        content[0] !== 0x1f || content[1] !== 0x8b || content[2] !== 0x08) {
      throw new Error("Invalid Apple financial report archive");
    }
    const sha256 = createHash("sha256").update(content).digest("hex");

    await pool.query(`
      WITH imported AS (
        INSERT INTO accounting_documents (month, kind, filename, content_type, content, sha256, uploaded_by)
        VALUES ($1::date, 'APPLE', $2, 'application/gzip', $3, $4, $5)
        ON CONFLICT (month, sha256) DO NOTHING
        RETURNING id
      )
      INSERT INTO accounting_audit_log (actor_kind, action, month, details)
      SELECT 'ANONYMOUS', 'IMPORT_APPLE_REPORT', $1::date, jsonb_build_object('documentId', id)
      FROM imported
    `, [`${month}-01`, `apple-financial-${month}.txt.gz`, content, sha256, adminId]);
  }
}
