import express from "express";
import cors from "cors";
import gigsRoutes from "./routes/gigs.routes";
import usersRoutes from "./routes/users.routes";

const app = express();

// --- CONFIGURACIÓN DE CORS ---
const allowedOrigins = [
  "https://tocadapp.com",
  "https://www.tocadapp.com",
  "http://localhost:3000", // Útil para tus pruebas locales
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Permite peticiones sin origen (como Postman o curl) o de la lista blanca
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("No permitido por CORS"));
      }
    },
    credentials: true, // VITAL si usas cookies o headers de autorización
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json());

// --- MONITOREO ---
app.get("/", (_req, res) => {
  res.json({ message: "TocadApp API is running" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, environment: process.env.NODE_ENV });
});

// --- RUTAS ---
// Opción A: Si en Nginx usas `rewrite ^/api/(.*) /$1 break;`
app.use("/gigs", gigsRoutes);
app.use("/users", usersRoutes);

/* Opción B (Recomendada): Si en Nginx solo usas `proxy_pass http://localhost:4000;` 
sin rewrite, añade el prefijo /api aquí para evitar confusiones:
app.use("/api/gigs", gigsRoutes);
app.use("/api/users", usersRoutes);
*/

export default app;
