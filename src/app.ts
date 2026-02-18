import express from "express";
import cors from "cors";
import gigsRoutes from "./routes/gigs.routes";
import usersRoutes from "./routes/users.routes";

const app = express();

const allowedOrigins = [
  "https://tocadapp.com",
  "https://www.tocadapp.com",
  "http://localhost:3000",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("No permitido por CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ message: "TocadApp API is running" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, environment: process.env.NODE_ENV });
});

app.use("/gigs", gigsRoutes);
app.use("/users", usersRoutes);

export default app;
