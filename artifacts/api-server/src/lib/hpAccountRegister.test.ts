import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import * as XLSX from "xlsx";
import { ensureHpProfile, importHpWorkbook, previewHpImport, resolveHpAccount } from "./hpBiImport";
import { hpMissingFields } from "./hpAccountCompletion";
import { matchHpRoster } from "./hpRosterMatch";
import { loadHpBi } from "./hpBiMetrics";

function workbook(headers: string[], rows: unknown[][]) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([headers, ...rows]), "Final");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("HP unified account register", () => {
  let tenantId: number, clientId: number, otherClientId: number, bareId: number, contactId: number;
  const filters = () => ({ clientId, year: 2027, page: 1, pageSize: 25 });
  beforeAll(async () => {
    tenantId = Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('HP register test',$1) RETURNING id",
      [`hp-register-${Date.now()}`])).rows[0].id);
    clientId = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenantId])).rows[0].id);
    otherClientId = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Other') RETURNING id", [tenantId])).rows[0].id);
    bareId = Number((await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Existing inbound company') RETURNING id",
      [tenantId, clientId])).rows[0].id);
    await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Foreign client company')", [tenantId, otherClientId]);
    // Account journey totals use additive engagement points, independently of formula intent.
    contactId = Number((await pool.query(`INSERT INTO contacts(tenant_id,client_id,company_id,first_name,email,intent_score,lead_score)
      VALUES($1,$2,$3,'Respondent','register@example.invalid',77,77) RETURNING id`, [tenantId, clientId, bareId])).rows[0].id);
    await pool.query(`INSERT INTO hp_bi_records(tenant_id,client_id,account_id,contact_id,kind,occurred_at,product,source,source_key)
      VALUES($1,$2,$3,$4,'interest','2025-02-01','HP Poly','offline','register-interest')`, [tenantId, clientId, bareId, contactId]);
  });
  afterAll(async () => {
    if (!tenantId) return;
    for (const table of ["hp_bi_records", "hp_bi_matches", "hp_bi_imports", "hp_bi_contacts", "hp_account_profiles",
      "contacts", "companies", "clients", "intent_inbound_category_rules"])
      await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenantId]);
    await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  });
  it("includes an unprofiled account without inventing a parent, moving contacts or losing old preferences", async () => {
    const d = await loadHpBi(tenantId, { ...filters(), parentKey: `company:${bareId}` }, true) as any;
    expect(d.account.contacts).toBe(1);
    expect(d.account.score).toBe(77);
    expect(d.account.missingFields).toContain("UNIQUE ID");
    expect(d.account.missingFields).toContain("TOP_NAME");
    expect(d.members[0].id).toBe(bareId);
    expect(d.recordedInterests).toEqual([expect.objectContaining({ product: "HP Poly", contactId, accountId: bareId })]);
    expect(d.records).toEqual([]); // Old interest is not a newly fabricated FY2027 lead.
    await loadHpBi(tenantId, filters());
    const count = await pool.query("SELECT count(*)::int n FROM hp_account_profiles WHERE tenant_id=$1", [tenantId]);
    expect(count.rows[0].n).toBe(1); // The other client's company is never registered.
    const preserved = (await pool.query("SELECT company_id,intent_score FROM contacts WHERE id=$1", [contactId])).rows[0];
    expect(preserved.company_id).toBe(bareId); expect(Number(preserved.intent_score)).toBe(77);
  });
  it("serializes simultaneous exact-name creates and reuses roster aliases", async () => {
    async function create(name: string) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const match = await resolveHpAccount(c, tenantId, clientId, null, name, true);
        await ensureHpProfile(c, tenantId, clientId, match.id!, name, match.created, "test CRM");
        await c.query("COMMIT");
        return match.id;
      } catch (e) { await c.query("ROLLBACK"); throw e; }
      finally { c.release(); }
    }
    const ids = await Promise.all([create("New legal account"), create(" new legal account ")]);
    expect(ids[0]).toBe(ids[1]);
    await pool.query("UPDATE hp_account_profiles SET aliases=ARRAY['Approved alias'] WHERE company_id=$1", [ids[0]]);
    expect(await create("Approved alias")).toBe(ids[0]);
    expect((await pool.query("SELECT count(*)::int n FROM companies WHERE tenant_id=$1 AND client_id=$2 AND lower(name)='new legal account'",
      [tenantId, clientId])).rows[0].n).toBe(1);
  });
  it("accepts missing HP IDs, keeps different names distinct, and preserves known hierarchy on a partial repeat", async () => {
    const full = workbook(["UNIQUE ID", "SUBSIDIARY_LEGAL_NAME", "TOP_ID", "TOP_NAME"],
      [["REGISTER-1", "Roster legal company", "REGISTER-P", "Known parent"]]);
    await importHpWorkbook(tenantId, clientId, full, "full.xlsx", "accounts", {}, null);
    const partial = workbook(["SUBSIDIARY_LEGAL_NAME", "CITY"], [["Roster legal company", "Delhi"], ["Missing ID company", "Mumbai"]]);
    const preview = previewHpImport(partial, "accounts", {});
    expect(preview.errors).toEqual([]);
    expect(preview.warnings.some(w => w.includes("missing HP ID"))).toBe(true);
    const first = await importHpWorkbook(tenantId, clientId, partial, "partial.xlsx", "accounts", {}, null);
    expect(first.created).toBe(1);
    const second = await importHpWorkbook(tenantId, clientId, partial, "partial-again.xlsx", "accounts", {}, null);
    expect(second.created).toBe(0);
    const known = (await pool.query("SELECT * FROM hp_account_profiles WHERE tenant_id=$1 AND hp_id='REGISTER-1'", [tenantId])).rows[0];
    expect(known.top_name).toBe("Known parent"); expect(known.parent_key).toBe("hp-top:REGISTER-P");
    const incomplete = await loadHpBi(tenantId, { ...filters(), incompleteOnly: true }) as any;
    expect(incomplete.accounts.some((a: any) => a.name === "Missing ID company" && a.missingFields.includes("UNIQUE ID"))).toBe(true);
  });
});

describe("HP completion coverage", () => {
  it("holds a name-only row that overlaps an explicit source ID instead of creating a second company", () => {
    const decisions = matchHpRoster([
      { hp_id: "ONE-ID", name: "One legal company", aliases: ["One legal company"], parent_key: "hp:ONE-ID" },
      { hp_id: null, name: "One legal company", aliases: ["One legal company"], parent_key: "name:one legal company" },
    ], []);
    expect(decisions[0].reason).toBeNull();
    expect(decisions[1].reason).toContain("duplicate");
  });
  it("counts unknown source fields but does not treat zero as missing or invent a source parent from grouping", () => {
    const fields = hpMissingFields({ hp_id: "ID", parent_name: "Standalone label", ps_tam_k: 0, prt_tam_k: "0", gtm: "-", top_name: "" });
    expect(fields).toContain("TOP_NAME"); expect(fields).toContain("FY25 GTM");
    expect(fields).not.toContain("UNIQUE ID"); expect(fields).not.toContain("PS TAM ($K)");
    expect(fields).not.toContain("PRT TAM ($K)");
  });
});
