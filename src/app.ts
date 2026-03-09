import express from "express";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./swagger";
import gigsRoutes from "./routes/gigs.routes";
import usersRoutes from "./routes/users.routes";
import musiciansRoutes from "./routes/musicians.routes";

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

app.use(
  "/api-docs",
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec, {
    customSiteTitle: "TocadApp API Docs",
    customCss: `
      .swagger-ui .topbar { background-color: #18181b; }
      .swagger-ui .topbar .download-url-wrapper { display: none; }
      .swagger-ui .info .title { color: #a855f7; }
    `,
    swaggerOptions: {
      docExpansion: "list",
      filter: true,
      showExtensions: true,
    },
  }),
);

app.get("/api-docs.json", (_req, res) => {
  res.json(swaggerSpec);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, environment: process.env.NODE_ENV });
});

app.use("/gigs", gigsRoutes);
app.use("/users", usersRoutes);
app.use("/musicians", musiciansRoutes);

export default app;
