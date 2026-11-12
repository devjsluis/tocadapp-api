export const accountingProviders = ["ALL", "STRIPE", "APPLE", "GOOGLE_PLAY", "MANUAL"] as const;
export const accountingStatuses = ["all", "available", "pending", "paid", "in_transit", "failed", "canceled", "confirmed", "registered"] as const;
export type AccountingFilters = {
  month: string | null; from: string; to: string;
  provider: typeof accountingProviders[number]; currency: string | null; status: typeof accountingStatuses[number];
};
export function validAccountingDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function accountingMonthEnd(month: string) {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
}
export function normalizeAccountingFilters(input: string | Record<string, unknown>): AccountingFilters {
  const query = typeof input === "string" ? { month: input } : input;
  const month = query.month;
  let from: string, to: string;
  if (month !== undefined && month !== null) {
    if (typeof month !== "string" || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(month) || query.from !== undefined || query.to !== undefined) throw Error("INVALID_MONTH");
    from = month + "-01"; to = accountingMonthEnd(month);
  } else {
    if (!validAccountingDate(query.from) || !validAccountingDate(query.to) || query.from > query.to) throw Error("INVALID_DATE_RANGE");
    from = query.from; to = query.to;
  }
  const provider = query.provider === undefined ? "ALL" : query.provider;
  const status = query.status === undefined ? "all" : query.status;
  const currency = query.currency === undefined || query.currency === "" || query.currency === null ? null : query.currency;
  if (typeof provider !== "string" || !accountingProviders.includes(provider as AccountingFilters["provider"]) ||
    typeof status !== "string" || !accountingStatuses.includes(status as AccountingFilters["status"]) ||
    (currency !== null && (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)))) throw Error("INVALID_FILTERS");
  return { month: typeof month === "string" ? month : null, from, to, provider: provider as AccountingFilters["provider"], currency, status: status as AccountingFilters["status"] };
}
export function accountingPeriodMonths(filters: Pick<AccountingFilters, "from" | "to">) {
  const months: string[] = [];
  let month = filters.from.slice(0, 7);
  while (month <= filters.to.slice(0, 7)) {
    months.push(month);
    const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1));
    month = next.toISOString().slice(0, 7);
  }
  return months;
}
export function fullAccountingMonths(filters: Pick<AccountingFilters, "from" | "to">) {
  return accountingPeriodMonths(filters).filter(month => filters.from <= month + "-01" && filters.to >= accountingMonthEnd(month));
}
export function accountingDocumentMatches(kind: string, provider: AccountingFilters["provider"]) {
  if (provider === "ALL" || ["CFDI", "BANK", "OTHER"].includes(kind)) return true;
  return kind === provider || (provider === "STRIPE" && kind === "STRIPE_FEES");
}
