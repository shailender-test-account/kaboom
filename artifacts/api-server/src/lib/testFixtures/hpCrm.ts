import * as XLSX from "xlsx";
import { pool } from "@workspace/db";
import { importHpWorkbook } from "../hpBiImport";

/** The same real workbook importer is used by reconciliation and browser tests. */
export function hpWorkbook(headers: string[], rows: unknown[][]): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([headers, ...rows]), "Data");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export async function seedHpCrmAccounts(tenantId: number, clientId: number) {
  await importHpWorkbook(tenantId, clientId, hpWorkbook(
    ["UNIQUE ID", "SUBSIDIARY_LEGAL_NAME", "TOP_ID", "TOP_NAME", "FY25 GTM", "PS RAD"],
    [["CRM-A", "CRM A", "CRM-P", "CRM Parent", "GCC", "R1"],
      ["CRM-B", "CRM B", "CRM-P", "CRM Parent", "Gov/Edu", "D1"]],
  ), "crm-roster.xlsx", "accounts", {}, null);
  const profiles = (await pool.query(
    "SELECT company_id FROM hp_account_profiles WHERE tenant_id=$1 ORDER BY hp_id", [tenantId],
  )).rows;
  const [companyId, siblingId] = profiles.map(p => Number(p.company_id));
  const contact = async (company: number, name: string, email: string) => Number((await pool.query(
    `INSERT INTO contacts(tenant_id,client_id,company_id,first_name,last_name,email)
     VALUES($1,$2,$3,$4,'Fixture',$5) RETURNING id`,
    [tenantId, clientId, company, name, email],
  )).rows[0].id);
  const contactId = await contact(companyId, "Alice", "crm-a@example.invalid");
  const siblingContact = await contact(siblingId, "Bob", "crm-b@example.invalid");
  return { companyId, siblingId, contactId, siblingContact };
}

/** Call only with a tenant created by the current test, never a user tenant. */
export async function cleanHpCrmTenant(tenantId: number) {
  for (const table of ["hp_parent_views", "intent_inbound_submissions", "deal_audit", "deals", "activity_events", "hp_bi_records", "hp_bi_matches", "hp_bi_contacts",
    "hp_bi_imports", "hp_account_profiles", "contacts", "companies", "clients", "intent_inbound_category_rules"]) {
    await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenantId]);
  }
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
}
