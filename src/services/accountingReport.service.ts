import { normalizeAccountingFilters, accountingPeriodMonths, fullAccountingMonths, accountingDocumentMatches, type AccountingFilters } from "./accountingFilters";
import { pool } from "../lib/db";
import { stripe } from "../lib/stripe";
import type Stripe from "stripe";

export const accountingTimezone = "America/Mexico_City";
export function validAccountingMonth(value: unknown): value is string {
  return typeof value === "string" && /^(20\d{2})-(0[1-9]|1[0-2])$/.test(value);
}
export type MoneySummary = { currency: string; grossMinor: number; feesMinor: number; refundsMinor: number; withheldMinor: number; netMinor: number; depositsMinor: number };
export type AccountingTransaction = { id: string; date: string; type: string; category: string; currency: string; amountMinor: number; feeMinor: number; netMinor: number; status: string };
export type AccountingPayout = { id: string; arrivalDate: string; currency: string; amountMinor: number; status: string };
export type AccountingInvoice = { id: string; number: string | null; paidAt: string; currency: string; amountMinor: number; pdfUrl: string | null };
export function safeInvoicePdf(url: string | null | undefined): string | null {
  if (!url) return null;
  try { const parsed = new URL(url); return parsed.protocol === "https:" &&
    ["pay.stripe.com", "invoice.stripe.com", "files.stripe.com"].includes(parsed.hostname) ? url : null; }
  catch { return null; }
}
export function summarizeStripe(transactions: AccountingTransaction[], payouts: AccountingPayout[]): MoneySummary[] {
  const currencies = new Map<string, MoneySummary>();
  const get = (currency: string) => {
    if (!currencies.has(currency)) currencies.set(currency, { currency, grossMinor: 0, feesMinor: 0, refundsMinor: 0, withheldMinor: 0, netMinor: 0, depositsMinor: 0 });
    return currencies.get(currency)!;
  };
  for (const row of transactions) {
    // Transfers out of Stripe are separate from revenue; never count the same money twice.
    if (["payout", "payout_cancel", "payout_failure"].includes(row.type)) continue;
    const summary = get(row.currency);
    if (["charge", "payment"].includes(row.category) && row.amountMinor > 0) summary.grossMinor += row.amountMinor;
    if (["refund", "payment_refund"].includes(row.category) && row.amountMinor < 0) summary.refundsMinor -= row.amountMinor;
    summary.feesMinor += row.feeMinor;
    if (row.type === "stripe_fee") summary.feesMinor -= row.amountMinor;
    summary.netMinor += row.netMinor;
  }
  for (const payout of payouts) if (payout.status === "paid") get(payout.currency).depositsMinor += payout.amountMinor;
  return [...currencies.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

export async function monthBounds(month: string) {
  if (!validAccountingMonth(month)) throw Error("INVALID_MONTH");
  const result = await pool.query<{ start: Date; end: Date }>(`SELECT
    ($1::date::timestamp AT TIME ZONE $2) AS start,
    (($1::date + interval '1 month')::timestamp AT TIME ZONE $2) AS "end"`, [month + "-01", accountingTimezone]);
  return result.rows[0];
}
export async function accountingDocuments(month: string) {
  if (!validAccountingMonth(month)) throw Error("INVALID_MONTH");
  return (await pool.query(`SELECT id,kind,filename,content_type AS "contentType",octet_length(content) AS bytes,
    to_char(month,'YYYY-MM') AS month,sha256,created_at AS "createdAt" FROM accounting_documents WHERE month=$1 ORDER BY created_at DESC`, [month + "-01"])).rows;
}
async function stripeMonth(start: Date, end: Date, references: string[]) {
  const range = { gte: Math.floor(start.getTime() / 1000), lt: Math.floor(end.getTime() / 1000) };
  const transactions: AccountingTransaction[] = [];
  const payouts: AccountingPayout[] = [];
  const invoices = new Map<string, AccountingInvoice>();
  const addInvoice = (invoice: Stripe.Invoice) => {
    const paidAt = invoice.status_transitions.paid_at;
    if (!paidAt || paidAt < range.gte || paidAt >= range.lt || invoice.status !== "paid") return;
    invoices.set(invoice.id, { id: invoice.id, number: invoice.number, paidAt: new Date(paidAt * 1000).toISOString(),
      currency: invoice.currency.toUpperCase(), amountMinor: invoice.amount_paid, pdfUrl: safeInvoicePdf(invoice.invoice_pdf) });
  };
  await Promise.all([
    (async () => {
      for await (const row of stripe.balanceTransactions.list({ created: range, limit: 100 })) {
        if (transactions.length >= 50000) throw Error("REPORT_TOO_LARGE");
        transactions.push({ id: row.id, date: new Date(row.created * 1000).toISOString(), type: row.type,
          category: row.reporting_category, currency: row.currency.toUpperCase(), amountMinor: row.amount,
          feeMinor: row.fee, netMinor: row.net, status: row.status });
      }
    })(),
    (async () => {
      for await (const row of stripe.payouts.list({ arrival_date: range, limit: 100 })) {
        if (payouts.length >= 50000) throw Error("REPORT_TOO_LARGE");
        payouts.push({ id: row.id, arrivalDate: new Date(row.arrival_date * 1000).toISOString(), currency: row.currency.toUpperCase(), amountMinor: row.amount, status: row.status });
      }
    })(),
    (async () => {
      let count = 0;
      for await (const invoice of stripe.invoices.list({ created: range, status: "paid", limit: 100 })) {
        if (++count > 50000) throw Error("REPORT_TOO_LARGE");
        addInvoice(invoice);
      }
      // An old invoice can be paid this month. Include those referenced by the payment ledger.
      for (const reference of new Set(references)) if (/^in_[A-Za-z0-9]+$/.test(reference) && !invoices.has(reference)) {
        addInvoice(await stripe.invoices.retrieve(reference));
      }
    })(),
  ]);
  return { status: "available" as const, transactions, payouts, invoices: [...invoices.values()], totals: summarizeStripe(transactions, payouts) };
}

export function filterStripeAccounting(data: Awaited<ReturnType<typeof stripeMonth>>, filters: AccountingFilters) {
  const currency = (value: string) => !filters.currency || value === filters.currency;
  const state = (value: string) => filters.status === "all" || value === filters.status;
  const transactions = data.transactions.filter(row => currency(row.currency) && state(row.status));
  const payouts = data.payouts.filter(row => currency(row.currency) && state(row.status));
  const invoices = data.invoices.filter(row => currency(row.currency) && state("paid"));
  return { ...data, transactions, payouts, invoices, totals: summarizeStripe(transactions, payouts) };
}
export async function accountingReport(input: string | Record<string, unknown>) {
  const filters = normalizeAccountingFilters(input);
  const bounds = filters.month ? await monthBounds(filters.month) : (await pool.query<{ start: Date; end: Date }>(
    `SELECT ($1::date::timestamp AT TIME ZONE $3) AS start,
      (($2::date + interval '1 day')::timestamp AT TIME ZONE $3) AS "end"`, [filters.from, filters.to, accountingTimezone])).rows[0];
  const { start, end } = bounds;
  const months = accountingPeriodMonths(filters);
  const fullMonths = fullAccountingMonths(filters);
  const selectedProvider = (provider: string) => filters.provider === "ALL" || filters.provider === provider;
  const [payments, settlements, periodDocuments] = await Promise.all([
    pool.query<{ id: number; provider: string; amount: number; currency: string; paid_at: Date; reference: string | null }>(
      `SELECT id,provider,amount,currency,paid_at,reference FROM subscription_payments
       WHERE paid_at >= $1 AND paid_at < $2 AND ($3::text='ALL' OR provider=$3)
         AND ($4::text IS NULL OR UPPER(TRIM(currency))=$4) ORDER BY paid_at,id`, [start, end, filters.provider, filters.currency]),
    pool.query(`SELECT s.id,s.provider,s.currency,to_char(s.month,'YYYY-MM') AS month,s.gross_minor AS "grossMinor",s.fees_minor AS "feesMinor",
      s.refunds_minor AS "refundsMinor",s.withheld_minor AS "withheldMinor",s.net_minor AS "netMinor",
      s.deposits_minor AS "depositsMinor",s.document_id AS "documentId",s.notes,s.updated_at AS "updatedAt"
      FROM accounting_settlements s WHERE s.month >= $1::date AND s.month <= $2::date
        AND ($3::text='ALL' OR s.provider=$3) AND ($4::text IS NULL OR s.currency=$4)
      ORDER BY s.provider,s.month,s.currency`, [months[0] + "-01", months[months.length-1] + "-01", filters.provider, filters.currency]),
    filters.month ? accountingDocuments(filters.month) : pool.query(`SELECT id,kind,filename,content_type AS "contentType",octet_length(content) AS bytes,
      to_char(month,'YYYY-MM') AS month,sha256,created_at AS "createdAt" FROM accounting_documents
      WHERE month >= $1::date AND month <= $2::date ORDER BY month,created_at DESC`,
      [months[0] + "-01", months[months.length-1] + "-01"]).then(result => result.rows),
  ]);
  const documents = periodDocuments.filter(row => accountingDocumentMatches(row.kind, filters.provider));
  let stripeData: Awaited<ReturnType<typeof stripeMonth>> | { status: "unavailable"; message: string } | { status: "not_selected" };
  if (!selectedProvider("STRIPE")) stripeData = { status: "not_selected" };
  else {
    try { stripeData = filterStripeAccounting(await stripeMonth(start, end, payments.rows.filter(row => row.provider === "STRIPE").map(row => row.reference ?? "")), filters); }
    catch { stripeData = { status: "unavailable", message: "No fue posible consultar Stripe. No se debe interpretar como un periodo sin ingresos." }; }
  }
  const manual = selectedProvider("MANUAL") && ["all", "registered"].includes(filters.status) ? payments.rows
    .filter(row => row.provider === "MANUAL" && (!filters.currency || row.currency.trim().toUpperCase() === filters.currency)).map(row => ({
      id: row.id, amountMinor: row.amount, currency: row.currency.trim().toUpperCase(), paidAt: row.paid_at.toISOString(), reference: row.reference,
    })) : [];
  // Store settlements have monthly granularity: never prorate or include a partial month's full amount.
  const nativeSelected = ["APPLE", "GOOGLE_PLAY"].filter(selectedProvider);
  const nativeState = ["all", "confirmed"].includes(filters.status);
  const confirmed = nativeState ? settlements.rows.filter(row => selectedProvider(row.provider) &&
    (!filters.currency || row.currency === filters.currency) && fullMonths.includes(row.month ?? filters.month)).map(row => ({
    ...row, month: row.month ?? filters.month, ...Object.fromEntries(
      ["grossMinor", "feesMinor", "refundsMinor", "withheldMinor", "netMinor", "depositsMinor"].map(key => {
        const value = Number(row[key]); if (!Number.isSafeInteger(value)) throw Error("UNSAFE_AMOUNT"); return [key, value];
      })) })) : [];
  const pendingProviderMonths = nativeState ? nativeSelected.flatMap(provider => fullMonths
    .filter(month => !confirmed.some(row => row.provider === provider && row.month === month)).map(month => ({ provider, month }))) : [];
  const partialMonths = nativeState && nativeSelected.length ? months.filter(month => !fullMonths.includes(month)) : [];
  return { month: filters.month, filters, periodLabel: filters.month ?? filters.from + " a " + filters.to,
    timezone: accountingTimezone, start: start.toISOString(), endExclusive: end.toISOString(),
    generatedAt: new Date().toISOString(), stripeMode: process.env.STRIPE_SECRET_KEY?.startsWith("sk_live_") ? "live" : "test",
    stripe: stripeData, manual, documents, settlements: confirmed, partialMonths, pendingProviderMonths,
    pendingProviders: [...new Set(pendingProviderMonths.map(row => row.provider))],
    guidance: "Reporte de apoyo contable. Cobros, saldo y transferencias son conceptos diferentes. Conciliar transferencias con el banco y reportes de Apple/Google. Sin coincidencias con los filtros no implica automáticamente una declaración en ceros. Los comprobantes Stripe no sustituyen un CFDI XML timbrado.",
  };
}

// CSV values originating in user/provider text cannot become spreadsheet formulas.
export function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  if (typeof value !== "number" && /^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
export function reportCsv(report: Awaited<ReturnType<typeof accountingReport>>) {
  const rows: unknown[][] = [["desde", "hasta", "filtro_proveedor", "filtro_moneda", "filtro_estado", "generado_en", "zona_horaria", "fuente", "tipo", "estado", "fecha", "referencia", "moneda", "importe", "comision", "neto", "nota"]];
  const add = (values: unknown[]) => rows.push([report.filters.from, report.filters.to, report.filters.provider, report.filters.currency ?? "TODAS", report.filters.status, report.generatedAt, report.timezone, ...values]);
  const zeroDecimals = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "VND", "VUV", "XAF", "XOF", "XPF"]);
  const amount = (minor: number, currency: string) => minor / (zeroDecimals.has(currency) ? 1 : 100);
  add(["REPORTE", "FILTROS", "APLICADOS", "", "", report.filters.currency ?? "", "", "", "", "Criterios de selección; no es un movimiento financiero"]);
  if (report.stripe.status === "available") {
    for (const row of report.stripe.transactions) add(["STRIPE", row.type, row.status, row.date, row.id, row.currency, amount(row.amountMinor,row.currency), amount(row.feeMinor,row.currency), amount(row.netMinor,row.currency), "Movimiento de saldo; no sumar las transferencias a los cobros"]);
    for (const row of report.stripe.payouts) add(["STRIPE", "TRANSFERENCIA", row.status, row.arrivalDate, row.id, row.currency, amount(row.amountMinor,row.currency), "", "", "Fecha de llegada estimada por Stripe; conciliar con banco"]);
    if (!report.stripe.transactions.length && !report.stripe.payouts.length) add(["STRIPE", "ESTADO", "SIN_COINCIDENCIAS", "", "", "", "", "", "", "Sin coincidencias con los filtros; no determina obligaciones fiscales"]);
  } else if (report.stripe.status === "unavailable") add(["STRIPE", "ESTADO", "NO_DISPONIBLE", "", "", "", "", "", "", report.stripe.message]);
  for (const row of report.manual) add(["MANUAL", "PAGO_REGISTRADO", "REGISTRADO", row.paidAt, row.reference, row.currency, amount(row.amountMinor,row.currency), "", "", "Importe registrado; conciliar con banco"]);
  for (const row of report.settlements) add([row.provider, "LIQUIDACION", "CON_DOCUMENTO", "", row.documentId, row.currency, amount(row.grossMinor,row.currency), amount(row.feesMinor,row.currency), amount(row.netMinor,row.currency),
    `Mes completo ${row.month}. Reembolsos=${amount(row.refundsMinor,row.currency)}; retenciones=${amount(row.withheldMinor,row.currency)}; depósitos=${amount(row.depositsMinor,row.currency)} ${row.currency}. ${row.notes}`]);
  for (const pending of report.pendingProviderMonths) add([pending.provider, "ESTADO", "PENDIENTE_REPORTE", pending.month, "", "", "", "", "", "Sin conciliación de ese mes/moneda; no equivale a cero"]);
  for (const month of report.partialMonths) add([report.filters.provider, "ESTADO", "MES_PARCIAL", month, "", "", "", "", "", "Liquidaciones de tienda excluidas: solo existen importes mensuales y no se prorratean"]);
  return "\uFEFF" + rows.map(row => row.map(csvCell).join(",")).join("\r\n");
}
