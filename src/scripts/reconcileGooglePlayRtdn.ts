import "dotenv/config";
import { pool } from "../lib/db";
import { reconcilePendingGooglePlayRtdn } from "../services/googlePlayRtdn.service";

import { reconcileGooglePlayAcknowledgements } from "../services/googlePlayAcknowledgement.service";

// One command, two independent obligations. Recover saved purchases first,
// without replaying entitlement synchronization just to acknowledge them.
reconcileGooglePlayAcknowledgements()
  .then(async (acknowledgements) => ({
    acknowledgements, rtdn: await reconcilePendingGooglePlayRtdn(),
  }))
  .then((summary) => {
    console.log("Google Play reconciliation:", summary);
    if (summary.acknowledgements.failed > 0 || summary.rtdn.failed > 0) process.exitCode = 1;
  })
  .catch(() => {
    console.error("Google Play reconciliation failed");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
