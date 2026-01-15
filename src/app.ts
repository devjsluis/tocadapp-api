import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({
    message: "TocadApp API is running",
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
  });
});

export default app;
