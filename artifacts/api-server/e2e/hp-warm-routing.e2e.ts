import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { runHpWarmSweep } from "../src/lib/hpWarmRouting";
import { test, expect } from "./fixtures/hp-crm";

const root = process.env.HP_CRM_E2E_URL || "http://localhost:80";
test("admin can inspect persisted Warm routing outcomes, filter, refresh and reopen after reload", async ({ page, hp }) => {
  // The fixture provides private authentication, real routes and a disposable
  // tenant. No application auth bypass or external sends are involved.
  await pool.query(`INSERT INTO intent_inbound_submissions(tenant_id,client_id,account_id,contact_id,
    drive_file_id,row_key,file_name,form_type,classification,classification_reason,product_interest,purchase_timeframe_months,submitted_at)
    VALUES($1,$2,$3,$4,$5,$5,'Warm routing browser fixture','event_feedback','warm','fixture','HP Device as a Service',6,NOW())`,
  [hp.tenantId, hp.clientId, hp.companyId, hp.contactId, randomUUID()]);
  const safe = process.env.COPIED_DATA_SAFE_MODE, enabled = process.env.HP_WARM_JOURNEY_ROUTING_ENABLED;
  try {
    process.env.COPIED_DATA_SAFE_MODE = "false";
    await runHpWarmSweep(hp.tenantId, hp.clientId);
  } finally {
    if (safe === undefined) delete process.env.COPIED_DATA_SAFE_MODE; else process.env.COPIED_DATA_SAFE_MODE = safe;
    if (enabled === undefined) delete process.env.HP_WARM_JOURNEY_ROUTING_ENABLED; else process.env.HP_WARM_JOURNEY_ROUTING_ENABLED = enabled;
  }
  await page.goto(`${root}/analytics?clientId=${hp.clientId}`);
  await page.getByRole("button", { name: "Warm routing", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Warm journey routing", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Unmapped (1)", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Unmapped (1)", exact: true }).click();
  await expect(page.getByRole("cell", { name: /Enable an explicit product\/category Warm mapping for HP Device as a Service/ })).toBeVisible();
  await page.getByRole("button", { name: "Routed (0)", exact: true }).click();
  await expect(page.getByText("No accounts match on this page. Use Next to review more accounts.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "All accounts", exact: true }).click();
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Unmapped", exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Warm routing", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Unmapped", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath("warm-routing.png"), fullPage: true });
  await page.getByRole("button", { name: "CRM A, CRM B", exact: true }).click();
  await expect(page.getByTestId("account-priority")).toBeVisible();
  // Account details mount an additional history reader after the priority
  // header. Wait for its real result before fixture teardown unregisters routes.
  await expect(page.getByTestId("engagement-summary")).toBeVisible();
});

test("bulk routing previews product contacts, assigns a published journey and never restarts completed sequences", async ({page,hp}) => {
  const journeyId=Number((await pool.query(`INSERT INTO journeys(tenant_id,client_id,name,slug,status)
    VALUES($1,$2,'Bulk fixture journey',$3,'published') RETURNING id`,
  [hp.tenantId,hp.clientId,`bulk-${randomUUID()}`])).rows[0].id);
  const sequenceId=Number((await pool.query(`INSERT INTO email_sequences(tenant_id,client_id,name,status)
    VALUES($1,$2,'Bulk fixture sequence','active') RETURNING id`,[hp.tenantId,hp.clientId])).rows[0].id);
  try {
    // A completed historical enrollment exercises sequence selection without creating sends or queue jobs.
    await pool.query("INSERT INTO sequence_enrollments(sequence_id,contact_id,status) VALUES($1,$2,'completed')",[sequenceId,hp.contactId]);
    await pool.query(`INSERT INTO intent_inbound_routing_rules(tenant_id,client_id,name,journey_id,sequence_id,match_type)
      VALUES($1,$2,'Bulk fixture rule',$3,$4,'fallback')`,[hp.tenantId,hp.clientId,journeyId,sequenceId]);
    await pool.query(`INSERT INTO intent_inbound_submissions(tenant_id,client_id,account_id,contact_id,
      drive_file_id,row_key,file_name,form_type,classification,classification_reason,product_interest,purchase_timeframe_months,submitted_at)
      VALUES($1,$2,$3,$4,$5,$5,'Bulk browser fixture','event_feedback','warm','fixture','HP Device as a Service',6,NOW())`,
    [hp.tenantId,hp.clientId,hp.companyId,hp.contactId,randomUUID()]);
    await page.goto(`${root}/analytics?clientId=${hp.clientId}`);
    await page.getByRole("button",{name:"Warm routing",exact:true}).click();
    await page.getByRole("checkbox",{name:"Select CRM A, CRM B",exact:true}).check();
    await page.getByRole("combobox",{name:"Product interest for bulk routing"}).selectOption("HP Device as a Service");
    await page.getByRole("combobox",{name:"Destination journey"}).selectOption(String(journeyId));
    await page.getByRole("combobox",{name:"Destination sequence"}).selectOption(String(sequenceId));
    await page.getByRole("button",{name:"Preview contacts",exact:true}).click();
    await expect(page.getByText("1 eligible contacts; 0 blocked contacts will be skipped.",{exact:true})).toBeVisible();
    await expect(page.getByRole("button",{name:"Confirm bulk routing",exact:true})).toBeDisabled();
    await page.getByRole("checkbox",{name:/I reviewed these contacts/}).check();
    await page.getByRole("button",{name:"Confirm bulk routing",exact:true}).click();
    await expect(page.getByText("Existing: completed (not restarted)",{exact:true})).toBeVisible();
    expect((await pool.query("SELECT 1 FROM journey_contacts WHERE journey_id=$1 AND contact_id=$2",[journeyId,hp.contactId])).rowCount).toBe(1);
    expect((await pool.query("SELECT status FROM sequence_enrollments WHERE sequence_id=$1 AND contact_id=$2",[sequenceId,hp.contactId])).rows).toEqual([{status:"completed"}]);
  } finally {
    await pool.query("DELETE FROM intent_inbound_routing_rules WHERE tenant_id=$1",[hp.tenantId]);
    await pool.query("DELETE FROM sequence_enrollments WHERE sequence_id=$1",[sequenceId]);
    await pool.query("DELETE FROM email_sequences WHERE id=$1",[sequenceId]);
    await pool.query("DELETE FROM journey_contacts WHERE journey_id=$1",[journeyId]);
    await pool.query("DELETE FROM journeys WHERE id=$1",[journeyId]);
  }
});
