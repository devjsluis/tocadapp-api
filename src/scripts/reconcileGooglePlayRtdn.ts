import "dotenv/config";
import { pool } from "../lib/db";
import { reconcilePendingGooglePlayRtdn } from "../services/googlePlayRtdn.service";

reconcilePendingGooglePlayRtdn()
  .then((summary) => {
    console.log("Google Play RTDN reconciliation:", summary);
    if (summary.failed > 0) process.exitCode = 1;
  })
  .catch(() => {
    console.error("Google Play RTDN reconciliation failed");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
