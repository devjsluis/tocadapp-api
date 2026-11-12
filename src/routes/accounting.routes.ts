import express, { NextFunction, Request, Response, Router } from "express";
import { rateLimit } from "express-rate-limit";
import { createHash } from "node:crypto";
import { pool } from "../lib/db";
import { authMiddleware } from "../middleware/auth";
import { requireAdmin } from "../middleware/requireAdmin";
import { accountantHandlers } from "../controllers/accounting.controller";

export function accountingOrigin(req: Request, res: Response, next: NextFunction) {
  const allowed = ["https://tocadapp.com", "https://www.tocadapp.com"];
  if (process.env.NODE_ENV !== "production") allowed.push("http://localhost:3000", "http://localhost:4000");
  if (!req.headers.origin || !allowed.includes(req.headers.origin)) {
    res.status(403).json({ error: "Origen no permitido" }); return;
  }
  next();
}
export function accountingNoStore(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
}
const ipLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, skipSuccessfulRequests: true,
  standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Demasiados intentos. Intenta más tarde." } });
const accountLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true,
  keyGenerator: req => createHash("sha256").update(typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : "missing").digest("hex"),
  standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Demasiados intentos. Intenta más tarde." } });

export const accountingRouter = Router();
accountingRouter.use(accountingNoStore);
accountingRouter.post("/login", accountingOrigin, ipLimit, accountLimit, accountantHandlers.login);
accountingRouter.use(accountantHandlers.require);
accountingRouter.get("/session", accountantHandlers.session);
accountingRouter.post("/logout", accountingOrigin, accountantHandlers.logout);
accountingRouter.get("/report", accountantHandlers.report);
accountingRouter.get("/export", accountantHandlers.export);
accountingRouter.get("/documents/:id", accountantHandlers.document);

export const adminAccountingRouter = Router();
adminAccountingRouter.use(accountingNoStore, authMiddleware, requireAdmin);
adminAccountingRouter.get("/accounts", accountantHandlers.accounts);
adminAccountingRouter.post("/accounts", accountantHandlers.createAccount);
adminAccountingRouter.post("/accounts/:id/rotate", accountantHandlers.rotateAccount);
adminAccountingRouter.post("/accounts/:id/revoke", accountantHandlers.revokeAccount);
adminAccountingRouter.get("/report", accountantHandlers.report);
adminAccountingRouter.get("/export", accountantHandlers.export);
adminAccountingRouter.get("/documents", accountantHandlers.documents);
adminAccountingRouter.get("/documents/:id", accountantHandlers.document);
adminAccountingRouter.post("/documents", express.raw({ type: ["application/pdf", "application/xml", "text/xml", "text/csv"], limit: "10mb" }), accountantHandlers.upload);
adminAccountingRouter.delete("/documents/:id", accountantHandlers.removeDocument);
adminAccountingRouter.put("/settlements", accountantHandlers.settlement);
adminAccountingRouter.get("/audit", async (_req, res) => {
  try { res.json({ events: (await pool.query("SELECT actor_kind,actor_id,action,to_char(month,'YYYY-MM') AS month,details,created_at FROM accounting_audit_log ORDER BY id DESC LIMIT 100")).rows }); }
  catch { res.status(503).json({ error: "No fue posible consultar el registro contable" }); }
});
