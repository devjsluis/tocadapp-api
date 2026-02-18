import "dotenv/config";
import app from "./app";

const PORT = Number(process.env.PORT) || 4000;
const HOST = "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`🚀 TocadApp API running on http://${HOST}:${PORT}`);
});
