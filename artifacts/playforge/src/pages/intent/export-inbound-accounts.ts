import type { IntentInboundAccount } from "@/hooks/use-intent";

export type InboundAccountExportFilters = {
  sourceId?: number;
  search?: string;
  classification?: "hot" | "warm" | "cold" | "manual";
  formType?: "lead_form" | "event_feedback";
  dateRange?: number;
  category?: string;
  product?: string;
};

function csvCell(value: string | number | null | undefined): string {
  let text = String(value ?? "");
  // Account names, products, and respondent fields come from imports. Treat
  // spreadsheet formulas as text when the CSV is opened in Excel or Sheets.
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function inboundAccountsCsv(accounts: IntentInboundAccount[]): string {
  const headers = [
    "Account ID", "Account", "Domain", "Classification", "Form type",
    "Responses", "Respondents", "Latest response", "Product interests",
    "Respondent names", "Respondent emails", "Classification reason",
  ];
  const rows = accounts.map(account => [
    account.account_id,
    account.name,
    account.domain,
    account.classification ?? "Unclassified",
    account.form_type,
    account.response_count,
    account.respondents.length,
    account.submitted_at ?? account.imported_at,
    [...new Set(account.respondents.flatMap(person => person.interests.map(interest => interest.selection)))].join("; "),
    account.respondents.map(person => person.name).filter(Boolean).join("; "),
    [...new Set(account.respondents.map(person => person.email).filter(Boolean))].join("; "),
    account.classification_reason,
  ]);
  return `\uFEFF${[headers, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export async function fetchInboundAccountsForExport(filters: InboundAccountExportFilters): Promise<IntentInboundAccount[]> {
  const accounts: IntentInboundAccount[] = [];
  let total = 0;
  let totalPages = 1;

  for (let page = 1; page <= totalPages; page++) {
    const query = new URLSearchParams({ page: String(page), pageSize: "100" });
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    const response = await fetch(`/api/intent/inbound/accounts?${query}`, { credentials: "include" });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.error ?? `Could not export accounts (${response.status})`);
    }
    const data = await response.json() as {
      accounts: IntentInboundAccount[]; total: number; totalPages: number;
    };
    if (page === 1) {
      total = data.total;
      totalPages = data.totalPages;
    }
    if (data.total !== total || (page <= totalPages && !data.accounts.length)) {
      throw new Error("The account list changed during export. Please try again.");
    }
    accounts.push(...data.accounts);
  }

  if (!total) throw new Error("No accounts match the current filters.");
  if (accounts.length !== total || new Set(accounts.map(account => account.account_id)).size !== total) {
    throw new Error("The account list changed during export. Please try again.");
  }
  return accounts;
}

export async function downloadInboundAccountsCsv(filters: InboundAccountExportFilters): Promise<number> {
  const accounts = await fetchInboundAccountsForExport(filters);
  const blob = new Blob([inboundAccountsCsv(accounts)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `inbound-accounts-${filters.classification ?? "all"}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return accounts.length;
}