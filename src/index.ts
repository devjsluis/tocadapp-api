import "dotenv/config";
import app from "./app";
import { checkGigReminders } from "./services/gigReminders.service";
import { checkPushReceipts } from "./services/pushNotifications.service";
import { importGooglePlayAccountingReports } from "./services/googlePlayAccountingReports.service";
import { importAppleAccountingReports } from "./services/appleAccountingReports.service";

const PORT = Number(process.env.PORT) || 4000;
const HOST = "0.0.0.0";

const FIVE_MINUTES = 5 * 60 * 1000;

app.listen(PORT, HOST, () => {
  if (process.env.ACCOUNTING_APPLE_VENDOR_NUMBER) {
    const importReports = () => {
      void importAppleAccountingReports().catch(() => {
        console.error("Apple accounting report import failed");
      });
    };
    setTimeout(importReports, 60_000);
    setInterval(importReports, 24 * 60 * 60 * 1000);
  }
  if (process.env.ACCOUNTING_GOOGLE_PLAY_BUCKET) {
    const importReports = () => {
      void importGooglePlayAccountingReports().catch(() => {
        console.error("Google Play accounting report import failed");
      });
    };
    setTimeout(importReports, 60_000);
    setInterval(importReports, 24 * 60 * 60 * 1000);
  }
  console.log(`🚀 TocadApp API running on http://${HOST}:${PORT}`);

  setTimeout(() => {
    void checkGigReminders();
  }, 10_000);

  setInterval(() => {
    void checkGigReminders();
  }, FIVE_MINUTES);

  setTimeout(() => {
    void checkPushReceipts();
  }, 30_000);

  setInterval(() => {
    void checkPushReceipts();
  }, FIVE_MINUTES);
});
