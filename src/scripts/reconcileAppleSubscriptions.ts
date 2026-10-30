import "dotenv/config";
import { pool } from "../lib/db";
import { appleEnvironment } from "../lib/apple";
import { syncAppleSubscription } from "../services/appleSubscription.service";

// Run periodically from the scheduler. This script writes subscription state;
// do not invoke against production without the normal deployment authorization.
async function reconcile() {
  const result = await pool.query<{ environment: string; transaction_id: string; user_id: number }>(`
    SELECT environment, transaction_id, user_id FROM apple_subscription_chains
    ORDER BY verified_at ASC LIMIT 500`);
  let failed = 0;
  for (const row of result.rows) {
    try {
      if (row.environment !== appleEnvironment(row.user_id)) continue;
      await syncAppleSubscription(row.transaction_id, row.user_id);
    } catch {
      failed++;
      // Do not log transaction identifiers, signed payloads or credentials.
      console.error("Apple subscription reconciliation failed for user", row.user_id);
    }
  }
  console.log("Apple reconciliation:", result.rows.length, "examined;", failed, "failed.");
  if (failed) process.exitCode = 1;
}
void reconcile().catch(() => {
  console.error("Apple reconciliation unavailable.");
  process.exitCode = 1;
}).finally(() => pool.end());
