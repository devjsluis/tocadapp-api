import { normalizeAccountingFilters } from "../services/accountingFilters";
import type { Request, Response } from "express";
import { accountingCookieName, accountingCookieOptions, auditAccounting, changeAccountant,
  createAccountant, listAccountants, loginAccountant, logoutAccountant, requireAccountant,
  type AccountingActor, type AccountingRequest } from "../services/accountingAuth.service";
import { accountingDocuments, accountingReport, reportCsv, validAccountingMonth } from "../services/accountingReport.service";
import { downloadAccountingDocument, removeAccountingDocument, saveSettlement, uploadAccountingDocument,
  validateAccountingDocument, validateSettlement } from "../services/accountingDocuments.service";

function actor(req: AccountingRequest): AccountingActor {
  return req.accountant ? { kind: "ACCOUNTANT", id: req.accountant.id } : { kind: "ADMIN", id: req.user!.id };
}
function month(req: Request) {
  if (!validAccountingMonth(req.query.month)) throw Error("INVALID_MONTH");
  return req.query.month;
}
function id(req: Request) {
  const value = String(req.params.id);
  if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647) throw Error("INVALID_ID");
  return Number(value);
}
function handler(run: (req: AccountingRequest, res: Response) => Promise<unknown>) {
  return async (req: AccountingRequest, res: Response) => {
    try { await run(req, res); }
    catch (error) {
      const message = error instanceof Error ? error.message : "";
      const code = (error as { code?: string })?.code;
      if (message.startsWith("INVALID_")) { res.status(400).json({ error: "Revisa el periodo, los importes y el documento seleccionado.", code: message }); return; }
      if (message.endsWith("_NOT_FOUND")) { res.status(404).json({ error: "No se encontró el registro solicitado" }); return; }
      if (code === "23505") { res.status(409).json({ error: "El acceso o documento ya existe" }); return; }
      if (code === "23503" || code === "23001") { res.status(409).json({ error: "El documento respalda una conciliación y no se puede eliminar" }); return; }
      res.status(503).json({ error: "El módulo contable no está disponible. Intenta nuevamente más tarde." });
    }
  };
}
export const accountantHandlers = {
  require: requireAccountant,
  login: handler(async (req, res) => {
    const session = await loginAccountant(req.body?.username, req.body?.password);
    if (!session) { res.status(401).json({ error: "Credenciales contables inválidas" }); return; }
    res.cookie(accountingCookieName(), session.token, accountingCookieOptions());
    res.json({ account: session.account });
  }),
  session: handler(async (req, res) => { res.json({ account: req.accountant }); }),
  logout: handler(async (req, res) => {
    await logoutAccountant(req);
    res.clearCookie(accountingCookieName(), { ...accountingCookieOptions(), maxAge: undefined });
    res.json({ ok: true });
  }),
  report: handler(async (req, res) => {
    const selected = normalizeAccountingFilters(req.query);
    const report = await accountingReport(req.query);
    await auditAccounting(actor(req), "VIEW_REPORT", selected.month ?? undefined, selected);
    res.json(report);
  }),
  export: handler(async (req, res) => {
    const selected = normalizeAccountingFilters(req.query);
    const report = await accountingReport(req.query);
    await auditAccounting(actor(req), "EXPORT_REPORT", selected.month ?? undefined, selected);
    res.attachment(`tocadapp-contabilidad-${selected.month ?? selected.from + "_" + selected.to}.csv`).type("text/csv; charset=utf-8").send(reportCsv(report));
  }),
  document: handler(async (req, res) => {
    const documentId = id(req);
    const document = await downloadAccountingDocument(documentId);
    await auditAccounting(actor(req), "DOWNLOAD_DOCUMENT", document.month, { documentId });
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.attachment(document.filename).type(document.content_type).send(document.content);
  }),
  accounts: handler(async (_req, res) => { res.json({ accounts: await listAccountants() }); }),
  documents: handler(async (req, res) => { res.json({ documents: await accountingDocuments(month(req)) }); }),
  createAccount: handler(async (req, res) => { res.status(201).json(await createAccountant(req.user!.id, req.body?.username, req.body?.displayName)); }),
  rotateAccount: handler(async (req, res) => { res.json(await changeAccountant(req.user!.id, id(req), true)); }),
  revokeAccount: handler(async (req, res) => { res.json(await changeAccountant(req.user!.id, id(req), false)); }),
  upload: handler(async (req, res) => {
    const data = validateAccountingDocument(req.query.month, req.query.kind, req.query.filename, req.headers["content-type"] ?? "", req.body);
    res.status(201).json(await uploadAccountingDocument(req.user!.id, data));
  }),
  removeDocument: handler(async (req, res) => { await removeAccountingDocument(req.user!.id, id(req)); res.json({ ok: true }); }),
  settlement: handler(async (req, res) => { res.json(await saveSettlement(req.user!.id, validateSettlement(req.body ?? {}))); }),
};
