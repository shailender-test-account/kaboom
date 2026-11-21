import { describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { canonicalInboundSubmissionSql } from "./inboundSubmissionDuplicates";

const first = {
  id:1,tenant_id:10,client_id:20,source_id:30,account_id:40,contact_id:50,
  form_type:"event_feedback",product_interest:"HP Set-up Services",purchase_timeframe_months:3,
  classification:"hot",explicit_interest:true,requested_demo:false,is_decision_maker:true,
  affinity_reviews:{},identity_review:null,routing_error:null,routing_status:"pending",
  raw_fields:{Name:"Test person","Services":"HP Set-up Services",Timeline:"0–3 months",__submissionDateOrigin:"upload"},
  submitted_at:"2026-09-23T16:56:03.706Z",created_at:"2026-09-23T17:58:35Z",
};
const second={...first,id:2,submitted_at:"2026-09-23T16:56:02.881Z",created_at:"2026-09-23T17:58:40Z"};
async function kept(rows:Record<string,unknown>[]) {
  // Real PostgreSQL semantics, entirely synthetic input; no persisted writes.
  const result=await pool.query(`WITH intent_inbound_submissions AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
      id int,tenant_id int,client_id int,source_id int,account_id int,contact_id int,
      form_type text,product_interest text,purchase_timeframe_months int,classification text,
      explicit_interest boolean,requested_demo boolean,is_decision_maker boolean,
      affinity_reviews jsonb,identity_review text,routing_error text,routing_status text,raw_fields jsonb,
      submitted_at timestamptz,created_at timestamptz))
    SELECT s.id FROM intent_inbound_submissions s WHERE ${canonicalInboundSubmissionSql("s")} ORDER BY s.id`,
    [JSON.stringify(rows)]);
  return result.rows.map(row=>row.id);
}
describe("Autonomous GTM duplicate imported responses",()=>{
  it("keeps one exact upload copy despite subsecond upload-date differences",async()=>{
    expect(await kept([first,second])).toEqual([1]);
  });
  it("consolidates spreadsheet header line endings, whitespace and empty cells across reimports",async()=>{
    const raw_fields={...first.raw_fields,"Discussion on AI\nand digital tools":" Excellent ", "Suitable time":null};
    const reimport={...second,id:3,created_at:"2026-11-03T06:15:40Z",
      raw_fields:{...second.raw_fields,"Discussion on AI\r\nand digital tools":"Excellent","Suitable time":""}};
    expect(await kept([{...first,raw_fields},reimport])).toEqual([1]);
  });
  it("prefers a routed copy over an otherwise identical pending copy without creating outreach",async()=>{
    expect(await kept([first,{...second,routing_status:"routed"}])).toEqual([2]);
  });
  it("ignores Excel's fictitious epoch day for time-only answers but preserves the actual time",async()=>{
    const original={...first,raw_fields:{...first.raw_fields,"Suitable time":"1899-12-30T03:00:00.000Z"}};
    const reimport={...second,raw_fields:{...second.raw_fields,"Suitable time":"1899-12-31T03:00:00.000Z"}};
    expect(await kept([original,reimport])).toEqual([1]);
    expect(await kept([original,{...reimport,raw_fields:{...reimport.raw_fields,"Suitable time":"1899-12-31T04:00:00.000Z"}}])).toEqual([1,2]);
    expect(await kept([
      {...first,raw_fields:{...first.raw_fields,"Follow-up date":"2026-12-30"}},
      {...second,raw_fields:{...second.raw_fields,"Follow-up date":"2026-12-31"}},
    ])).toEqual([1,2]);
  });
  it("preserves conflicting normalized columns instead of silently overwriting an answer",async()=>{
    expect(await kept([
      {...first,raw_fields:{...first.raw_fields,"HP\nrating":"Excellent","HP\r\nrating":"Poor"}},
      {...second,raw_fields:{...second.raw_fields,"HP\nrating":"Poor"}},
    ])).toEqual([1,2]);
  });
  it.each(["tenant_id","client_id","source_id","account_id","contact_id"] as const)(
    "never merges different %s boundaries",async key=>{
      expect(await kept([first,{...second,[key]:999}])).toEqual([1,2]);
    });
  it("retains different form types, products, answers, qualification and reviews",async()=>{
    for(const change of [
      {form_type:"lead_form"},{product_interest:"HP Anyware"},
      {raw_fields:{...first.raw_fields,Timeline:"6 months"}},{purchase_timeframe_months:6},
      {classification:"warm"},
      {identity_review:"relink"},
    ]) expect(await kept([first,{...second,...change}])).toEqual([1,2]);
  });
  it("keeps the copy carrying all saved reviews, without losing a review or keeping an unreviewed duplicate",async()=>{
    expect(await kept([first,{...second,affinity_reviews:{"HP Set-up Services":"approved"}}])).toEqual([2]);
    expect(await kept([{...first,affinity_reviews:{"HP Set-up Services":"cold"}},
      {...second,affinity_reviews:{"HP Set-up Services":"warm"}}])).toEqual([1,2]);
  });
  it("retains real repeat submissions even a second apart",async()=>{
    const raw_fields={...first.raw_fields,__submissionDateOrigin:"source"};
    expect(await kept([{...first,raw_fields},{...second,raw_fields}])).toEqual([1,2]);
    expect(await kept([{...first,raw_fields},{...second,raw_fields,submitted_at:first.submitted_at}])).toEqual([1]);
  });
  it("does not merge different upload days or manually corrected dates",async()=>{
    expect(await kept([first,{...second,submitted_at:"2026-09-24T16:56:03Z"}])).toEqual([1,2]);
    expect(await kept([first,{...second,raw_fields:{...second.raw_fields,__submissionDateOverride:"2026-09-24"}}])).toEqual([1,2]);
  });
  it("does not collapse unknown people or empty responses",async()=>{
    expect(await kept([{...first,contact_id:null},{...second,contact_id:null}])).toEqual([1,2]);
    expect(await kept([{...first,raw_fields:{}},{...second,raw_fields:{}}])).toEqual([1,2]);
  });
  it("does not let a blocked identity copy hide a valid response",async()=>{
    expect(await kept([{...first,routing_error:"Form email belongs to another account."},second])).toEqual([1,2]);
  });
  it("rejects untrusted SQL aliases",()=>{
    expect(()=>canonicalInboundSubmissionSql("s; DROP TABLE contacts")).toThrow("Invalid submission alias");
  });
});
