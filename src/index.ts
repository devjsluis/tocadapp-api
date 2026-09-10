import "dotenv/config";
import app from "./app";
import { checkGigReminders } from "./services/gigReminders.service";
import { checkPushReceipts } from "./services/pushNotifications.service";

const PORT = Number(process.env.PORT) || 4000;
const HOST = "0.0.0.0";

const FIVE_MINUTES = 5 * 60 * 1000;

app.listen(PORT, HOST, () => {
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
