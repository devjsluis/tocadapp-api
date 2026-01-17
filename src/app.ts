import express from "express";
import cors from "cors";
import gigsRoutes from "./routes/gigs.routes";
import usersRoutes from "./routes/users.routes";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ message: "TocadApp API is running" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/gigs", gigsRoutes);
app.use("/users", usersRoutes);

export default app;
