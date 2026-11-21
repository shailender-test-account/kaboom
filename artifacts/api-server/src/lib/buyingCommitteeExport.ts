import { pool } from "@workspace/db";
import { committeePeopleSql, validateCommitteeContactScope } from "./buyingCommitteeContacts";
import { committeeCountryValues } from "./buyingCommitteeCountry";

/** Quote every cell and neutralize spreadsheet formulas, including whitespace prefixes. */
export function committeeCsvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
function row(values: unknown[]) { return values.map(committeeCsvCell).join(",") + "\r\n"; }

// Explicit allowlist: never serialize arbitrary DB rows, credentials, scores or inferred intent.
const columns = ["Account ID", "Company", "Name", "Designation", "Business email", "Available phone",
  "LinkedIn", "Location", "Provenance", "Requested categories (not intent)", "Sourced date",
  "Verified engagement", "Verified engagement sources"];

/**
 * One read-only snapshot and server-side cursor: no OFFSET ceiling or full-result JS buffer.
 * Cancelling the download closes the cursor/transaction and releases the connection.
 */
export async function* exportCommitteeCsv(tenantId: number, clientId: number, accountIds: number[],
  progress = { rowCount: 0 }, signal?: AbortSignal, country?: string) {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await connection.query("SET LOCAL statement_timeout = '30s'");
    await connection.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
    await validateCommitteeContactScope(tenantId, clientId, accountIds, connection);
    await connection.query(`DECLARE committee_export NO SCROLL CURSOR FOR ${committeePeopleSql}
      SELECT * FROM people ORDER BY engaged DESC,lower(name),"companyId",id`, [tenantId, clientId, accountIds, committeeCountryValues(country)]);
    let batch = await connection.query("FETCH FORWARD 200 FROM committee_export");
    signal?.throwIfAborted();
    yield "\uFEFF" + row(columns);
    while (batch.rows.length) {
      signal?.throwIfAborted();
      const chunk = batch.rows.map(p => row([p.companyId, p.companyName, p.name, p.title, p.email, p.phone,
        p.linkedin, p.location, p.source, p.categories.join("; "),
        p.sourcedAt ? new Date(p.sourcedAt).toISOString() : "", p.engaged ? "Yes" : "No",
        p.engagementSources.join("; ")])).join("");
      // Rows offered to the stream, not proof that the recipient saved the file.
      // The header is excluded; partial/cancelled exports may have a nonzero count.
      progress.rowCount += batch.rows.length;
      yield chunk;
      batch = await connection.query("FETCH FORWARD 200 FROM committee_export");
    }
  } finally {
    try { await connection.query("ROLLBACK"); } finally { connection.release(); }
  }
}
