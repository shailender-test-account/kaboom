import Papa from "papaparse";

export type BulkUserRow = {
  rowNumber: number; firstName: string; lastName: string; email: string; errors: string[];
};

export function parseBulkUserRows(rows: unknown[][], existingEmails: string[]): BulkUserRow[] {
  const populated = rows.filter(row => row.some(cell => String(cell ?? "").trim()));
  if (populated.length < 2) throw new Error("Add a header and at least one user.");
  if (populated.length > 51) throw new Error("Import up to 50 users at a time.");
  const aliases: Record<string, "firstName" | "lastName" | "email"> = {
    firstname: "firstName", lastname: "lastName", email: "email", emailaddress: "email",
  };
  const headers = populated[0].map(cell => String(cell ?? "").trim().toLowerCase().replace(/[\s_-]/g, ""));
  const fields = headers.map(header => aliases[header]);
  if (headers.some((header, i) => header && !fields[i])) {
    throw new Error("Use only First name, Last name and Email columns. Choose access settings below.");
  }
  for (const field of ["firstName", "lastName", "email"]) {
    if (fields.filter(value => value === field).length !== 1) throw new Error(`Include exactly one ${field} column.`);
  }
  const emails = new Set(existingEmails.map(email => email.trim().toLowerCase()));
  const duplicates = new Map<string, number>();
  const parsed = populated.slice(1).map((cells, index) => {
    const value = (field: "firstName" | "lastName" | "email") => String(cells[fields.indexOf(field)] ?? "").trim();
    const firstName = value("firstName"), lastName = value("lastName"), email = value("email").toLowerCase();
    const errors: string[] = [];
    if (!firstName || !lastName) errors.push("First and last name are required.");
    if (firstName.length > 120 || lastName.length > 120) errors.push("Names must be 120 characters or fewer.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) errors.push("Enter a valid email.");
    if (emails.has(email)) errors.push("Email is already registered.");
    if (cells.some((cell, i) => String(cell ?? "").trim() && !fields[i])) errors.push("Unexpected extra column.");
    duplicates.set(email, (duplicates.get(email) ?? 0) + 1);
    return { rowNumber: index + 2, firstName, lastName, email, errors };
  });
  return parsed.map(row => ({ ...row, errors: [...row.errors, ...((duplicates.get(row.email) ?? 0) > 1 ? ["Duplicate email in this batch."] : [])] }));
}

export function parseUserCsv(text: string, existingEmails: string[]) {
  const result = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });
  if (result.errors.length) throw new Error(`Could not read CSV: ${result.errors[0].message}`);
  return parseBulkUserRows(result.data, existingEmails);
}

export function downloadUserCsv(filename: string, rows: string[][]) {
  const blob = new Blob(["\uFEFF", Papa.unparse(rows, { escapeFormulae: true })], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
