import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { seedHpCrmAccounts, cleanHpCrmTenant } from "./testFixtures/hpCrm";
import { loadHpBi } from "./hpBiMetrics";
import { editInboundSubmissionDate, submissionDate, resolveSubmissionDate } from "./inboundSubmissionDate";

let tenantId: number, clientId: number, qualifiedResponseId: number, feedbackOnlyAccountId: number, hp: Awaited<ReturnType<typeof seedHpCrmAccounts>>;
beforeAll(async () => {
  tenantId = Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('HP GTM test',$1) RETURNING id", [randomUUID()])).rows[0].id);
  clientId = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenantId])).rows[0].id);
  hp = await seedHpCrmAccounts(tenantId, clientId);
  feedbackOnlyAccountId = Number((await pool.query(
    "INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Feedback-only account') RETURNING id",
    [tenantId, clientId])).rows[0].id);
  const add = async (account: number, product: string | null, months: number | null, date: string | null, review: string | null = null) =>
    pool.query(`INSERT INTO intent_inbound_submissions(tenant_id,client_id,account_id,drive_file_id,row_key,
      file_name,form_type,classification,classification_reason,product_interest,purchase_timeframe_months,submitted_at,identity_review)
      VALUES($1,$2,$3,$4,$4,'fixture.xlsx','event_feedback','warm','fixture',$5,$6,$7,$8) RETURNING id`,
    [tenantId, clientId, account, randomUUID(), product, months, date, review]);
  qualifiedResponseId = Number((await add(hp.companyId, "HP Anyware Services", 3, null)).rows[0].id);
  await pool.query("UPDATE intent_inbound_submissions SET form_type='lead_form' WHERE id=$1", [qualifiedResponseId]);
  await add(hp.companyId, "HP Proactive Insights", 3, "2024-01-01");
  await add(hp.siblingId, "HP Services", 6, null);
  await add(hp.companyId, null, 3, null);
  await add(feedbackOnlyAccountId, null, null, null);
  await add(hp.siblingId, "HP Anyware Services", 3, null, "keep");
  await pool.query("UPDATE intent_inbound_submissions SET created_at='2027-03-15T08:00:00Z' WHERE tenant_id=$1", [tenantId]);
});
afterAll(async () => { if (tenantId) await cleanHpCrmTenant(tenantId); });
it("uses original upload/import dates for undated responses, retaining explicit historical dates", async () => {
  const report: any = await loadHpBi(tenantId, { clientId, year: 2027, page: 1, pageSize: 25 });
  expect(report.summary.gtm).toMatchObject({ hotAccounts: 1, warmAccounts: 1, qualifiedAccounts: 2, responses: 3, undatedResponses: 0, uploadDateResponses: 2,
    inboundAccounts: 3, inboundResponses: 5, inboundHotAccounts: 1, inboundWarmAccounts: 1, inboundColdAccounts: 1 });
  expect(report.summary).toMatchObject({ hot: 1, warm: 1, leads: 2 });
  expect(report.months.find((m: any) => m.label === "Mar").leads).toBe(2);
  const account = report.accounts.find((a: any) => a.id === hp.companyId);
  expect(account.gtm.status).toBe("Hot");
  expect(account.gtm.formTypes).toEqual(["event_feedback", "lead_form"]);
  const feedback = report.accounts.find((a: any) => a.id === feedbackOnlyAccountId);
  expect(feedback.gtm).toMatchObject({ status: "Cold", inboundAccounts: 1, inboundResponses: 1, qualifiedAccounts: 0 });
  expect(feedback.leads).toBe(0);
  expect(feedback.gtm.formTypes).toEqual(["event_feedback"]);
  const detail: any = await loadHpBi(tenantId, { clientId, year: 2027, parentKey: account.parentKey, page: 1, pageSize: 25 }, true);
  expect(detail.intentSources.gtm).toEqual(expect.arrayContaining([
    expect.objectContaining({ product: "HP Anyware Services", status: "Hot" }),
    expect.objectContaining({ product: "HP Proactive Insights", status: "Hot" }),
    expect.objectContaining({ product: "HP Services", status: "Warm" }),
  ]));
  expect(detail.intentSources.gtm).toHaveLength(3);
  expect(detail.intentSources.journey).toEqual([]);
  expect(detail.gtmResponses).toContainEqual(expect.objectContaining({ product: "HP Anyware Services", status: "Hot", submittedAt: "2027-03-15T08:00:00.000Z", submissionDateOrigin: "upload", horizonMonths: 3 }));
});
it("uses file upload timestamps, retains recorded dates, and preserves corrections on resync", () => {
  const upload = "2027-03-15T08:00:00.000Z";
  expect(resolveSubmissionDate(null, undefined, upload).submittedAt.toISOString()).toBe(upload);
  const original = new Date("2024-01-01");
  expect(resolveSubmissionDate(original, undefined, upload).submittedAt).toEqual(original);
  expect(resolveSubmissionDate(null, { submitted_at: original }, upload).submittedAt).toEqual(original);
  const corrected = "2026-10-30T18:30:00.000Z";
  const result = resolveSubmissionDate(original, { raw_fields: {
    __submissionDateOverride: corrected, __submissionDateEditedBy: 1,
  } }, upload);
  expect(result.submittedAt.toISOString()).toBe(corrected);
  expect(result.dateMetadata.__submissionDateOverride).toBe(corrected);
  expect(resolveSubmissionDate(null, { created_at: original }).submittedAt).toEqual(original);
});
it("rejects invalid calendar days and isolates another tenant's date edits", async () => {
  for (const date of ["2027-02-29", "2026-13-01", "2027-04-31", "03/15/2027"])
    expect(() => submissionDate(date)).toThrow("valid submission date");
  expect(submissionDate("2028-02-29").toISOString()).toBe("2028-02-28T18:30:00.000Z");
  const id = Number((await pool.query("SELECT id FROM intent_inbound_submissions WHERE tenant_id=$1 LIMIT 1", [tenantId])).rows[0].id);
  await expect(editInboundSubmissionDate(tenantId + 10000000, id, "2027-01-31", 1)).rejects.toThrow("not found");
});
it("persists corrections and moves captured lead/response records to the corrected fiscal month", async () => {
  // Another undated response on this account has no product. Database row order
  // must not determine which response this correction regression exercises.
  const id = qualifiedResponseId;
  const original = (await pool.query("SELECT product_interest,purchase_timeframe_months,submitted_at FROM intent_inbound_submissions WHERE tenant_id=$1 AND id=$2",
    [tenantId, id])).rows[0];
  expect(original).toMatchObject({ product_interest: "HP Anyware Services", purchase_timeframe_months: 3, submitted_at: null });
  for (const key of [`inbound:${id}`, `inbound:${id}:response`]) {
    await pool.query(`INSERT INTO hp_bi_records(tenant_id,client_id,account_id,kind,occurred_at,product,horizon_months,source,source_key)
      VALUES($1,$2,$3,$4,'2027-03-15','HP Anyware Services',3,'questionnaire',$5)`,
    [tenantId, clientId, hp.companyId, key.endsWith(":response") ? "other" : "lead", key]);
  }
  await editInboundSubmissionDate(tenantId, id, "2026-10-31", 1);
  const row = (await pool.query("SELECT submitted_at,raw_fields FROM intent_inbound_submissions WHERE id=$1", [id])).rows[0];
  expect(new Date(row.submitted_at).toISOString()).toBe("2026-10-30T18:30:00.000Z");
  expect(row.raw_fields.__submissionDateOverride).toBeTruthy();
  const captured = (await pool.query("SELECT source_key,occurred_at FROM hp_bi_records WHERE tenant_id=$1 AND source_key=ANY($2::text[]) ORDER BY source_key",
    [tenantId, [`inbound:${id}`, `inbound:${id}:response`]])).rows;
  expect(captured).toHaveLength(2);
  expect(captured.map(r => new Date(r.occurred_at).toISOString())).toEqual([
    "2026-10-30T18:30:00.000Z", "2026-10-30T18:30:00.000Z",
  ]);
  expect((await pool.query("SELECT submitted_at FROM intent_inbound_submissions WHERE tenant_id=$1 AND account_id=$2 AND product_interest IS NULL",
    [tenantId, hp.companyId])).rows[0].submitted_at).toBeNull();
  const current: any = await loadHpBi(tenantId, { clientId, year: 2027, page: 1, pageSize: 25 });
  expect(current.summary).toMatchObject({ hot: 0, warm: 1, leads: 1 });
  const prior: any = await loadHpBi(tenantId, { clientId, year: 2026, page: 1, pageSize: 25 });
  expect(prior.summary.hot).toBe(1);
  expect(prior.months.find((m: any) => m.label === "Oct").hot).toBe(1);
});
it("retains fiscal-year accounting and respects segment and client ownership", async () => {
  const historical: any = await loadHpBi(tenantId, { clientId, year: 2024, page: 1, pageSize: 25 });
  expect(historical.summary.hot).toBe(1);
  expect(historical.summary.gtm.hotAccounts).toBe(1);
  expect(historical.summary.gtm).toMatchObject({ inboundAccounts: 3, inboundResponses: 5 });
  const empty: any = await loadHpBi(tenantId, { clientId, year: 2027, segment: "not-a-segment", page: 1, pageSize: 25 });
  expect(empty.summary.gtm).toMatchObject({ qualifiedAccounts: 0, responses: 0, inboundAccounts: 0, inboundResponses: 0 });
  const foreign: any = await loadHpBi(tenantId + 10000000, { clientId, year: 2027, page: 1, pageSize: 25 });
  expect(foreign.summary.gtm.qualifiedAccounts).toBe(0);
  expect(foreign.summary.gtm).toMatchObject({ inboundAccounts: 0, inboundResponses: 0 });
});
