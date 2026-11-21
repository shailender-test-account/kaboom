import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { importHpWorkbook } from "./hpBiImport";
import { loadHpBi } from "./hpBiMetrics";
import * as assignments from "./hpSalesAssignments";
import { hpWorkbook, cleanHpCrmTenant } from "./testFixtures/hpCrm";

it("enriches only the requested accounts while retaining exact totals, sorting and detail", async () => {
  const tenantId = Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('HP paging fixture',$1) RETURNING id", [randomUUID()])).rows[0].id);
  const spy = vi.spyOn(assignments, "hpSalesAssignments");
  try {
    const clientId = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenantId])).rows[0].id);
    await importHpWorkbook(tenantId, clientId, hpWorkbook(
      ["UNIQUE ID", "SUBSIDIARY_LEGAL_NAME", "TOP_ID", "TOP_NAME", "FY25 GTM", "PS RAD", "EAM email-ID"],
      Array.from({ length: 12 }, (_, i) => [`PAGE-${i}`, `Legal ${i}`, `P-${i}`, `Parent ${String(i).padStart(2, "0")}`, "GCC", "R1", "owner@example.invalid"]),
    ), "paging.xlsx", "accounts", {}, null);
    const filters = { clientId, year: 2027, page: 1, pageSize: 5, sortBy: "name" as const, sortDir: "asc" as const };
    spy.mockClear();
    const first: any = await loadHpBi(tenantId, filters);
    expect(first).toMatchObject({ total: 12, page: 1, pageSize: 5, summary: { accounts: 12, parentAccounts: 12 } });
    expect(first.accounts.map((a: any) => a.name)).toEqual(["Parent 00", "Parent 01", "Parent 02", "Parent 03", "Parent 04"]);
    expect(spy).toHaveBeenCalledTimes(5);
    expect(first.accounts[0].salesPeople[0].email).toBe("owner@example.invalid");
    expect(first.accounts[0].journeys).toEqual([]);
    spy.mockClear();
    const next: any = await loadHpBi(tenantId, { ...filters, page: 2 });
    expect(spy).toHaveBeenCalledTimes(5);
    expect(next.summary).toEqual(first.summary);
    expect(next.accounts[0].name).toBe("Parent 05");
    const last: any = await loadHpBi(tenantId, { ...filters, page: 3 });
    expect(last.accounts).toHaveLength(2);
    const detail: any = await loadHpBi(tenantId, { ...filters, page: 2, parentKey: first.accounts[0].parentKey }, true);
    expect(detail.account.parentKey).toBe(first.accounts[0].parentKey);
    expect(detail.account.salesPeople).toEqual(first.accounts[0].salesPeople);
    const exported: any = await loadHpBi(tenantId, { ...filters, pageSize: Number.MAX_SAFE_INTEGER });
    expect(exported.accounts).toHaveLength(12);
    const ownerAccount = first.accounts[0].id, otherAccount = first.accounts[1].id;
    await pool.query(`UPDATE hp_account_profiles SET eam_email='other@example.invalid',
      whitespace_categories=ARRAY['Business Collaboration']
      WHERE tenant_id=$1 AND company_id=$2`, [tenantId, ownerAccount]);
    await pool.query(`UPDATE hp_account_profiles SET whitespace_categories=ARRAY['Business Services']
      WHERE tenant_id=$1 AND company_id=$2`, [tenantId, otherAccount]);
    const scoped: any = await loadHpBi(tenantId, { ...filters, salesPerson: "OTHER@example.invalid", opportunity: "Business Collaboration" });
    expect(scoped).toMatchObject({ total: 1, summary: { accounts: 1, parentAccounts: 1, contacts: 0, score: 0 } });
    expect(scoped.accounts.map((a: any) => a.id)).toEqual([ownerAccount]);
    expect(scoped.accounts[0].salesPeople[0].email).toBe("other@example.invalid");
    const disjoint: any = await loadHpBi(tenantId, { ...filters, salesPerson: "other@example.invalid", opportunity: "Business Services" });
    expect(disjoint).toMatchObject({ total: 0, accounts: [], summary: { accounts: 0, parentAccounts: 0, leads: 0 } });
    const services: any = await loadHpBi(tenantId, { ...filters, opportunity: "Business Services" });
    expect(services.accounts.map((a: any) => a.id)).toEqual([otherAccount]);
    const unknown: any = await loadHpBi(tenantId, { ...filters, salesPerson: "absent@example.invalid" });
    expect(unknown.total).toBe(0);
     // Source selection must use the complete audience, not the first five rows.
     const addResponse = (accountId: number, formType: string, review: string | null = null) => pool.query(
       `INSERT INTO intent_inbound_submissions(tenant_id,client_id,account_id,drive_file_id,row_key,
         file_name,form_type,classification,classification_reason,product_interest,purchase_timeframe_months,identity_review)
        VALUES($1,$2,$3,$4,$4,'source-fixture.xlsx',$5,'hot','fixture','HP Services',3,$6)`,
       [tenantId, clientId, accountId, randomUUID(), formType, review]);
     await addResponse(next.accounts[0].id, "lead_form");
     await addResponse(last.accounts[0].id, "lead_form");
     await addResponse(otherAccount, "event_feedback");
     await addResponse(ownerAccount, "lead_form", "keep");
     const leadFilters = { ...filters, pageSize: 1, gtmSource: "lead_form" as const };
     const leads: any = await loadHpBi(tenantId, leadFilters);
     expect(leads.total).toBe(2);
     expect(leads.accounts.map((a: any) => a.name)).toEqual(["Parent 05"]);
     expect(leads.summary.accounts).toBe(12);
     const leadPage2: any = await loadHpBi(tenantId, { ...leadFilters, page: 2 });
     expect(leadPage2.accounts.map((a: any) => a.name)).toEqual(["Parent 10"]);
     const combined: any = await loadHpBi(tenantId, { ...leadFilters, qualification: "Hot", search: "Legal 10" });
     expect(combined.total).toBe(1);
     expect(combined.accounts[0].name).toBe("Parent 10");
     const noCold: any = await loadHpBi(tenantId, { ...leadFilters, qualification: "Cold" });
     expect(noCold.total).toBe(0);
     const feedback: any = await loadHpBi(tenantId, { ...filters, gtmSource: "event_feedback" });
     expect(feedback.accounts.map((a: any) => a.id)).toEqual([otherAccount]);
     const allLeadRows: any = await loadHpBi(tenantId, { ...leadFilters, pageSize: Number.MAX_SAFE_INTEGER });
     expect(allLeadRows.accounts).toHaveLength(2);
     const resetSources: any = await loadHpBi(tenantId, filters);
     expect(resetSources.total).toBe(12);
  } finally {
    spy.mockRestore();
    await cleanHpCrmTenant(tenantId);
  }
});
