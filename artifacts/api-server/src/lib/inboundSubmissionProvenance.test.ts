import { afterEach, describe, expect, it, vi } from "vitest";
import { pool } from "@workspace/db";
import { inboundSubmissionId, readInboundProvenance } from "./inboundSubmissionProvenance";

const first = {
  id: 1, tenant_id: 10, client_id: 20, source_id: 30, account_id: 40, contact_id: 50,
  form_type: "event_feedback", product_interest: "HP Set-up Services", purchase_timeframe_months: 3,
  classification: "hot", explicit_interest: true, requested_demo: false, is_decision_maker: true,
  affinity_reviews: {}, identity_review: null, routing_error: null,routing_status:"pending",
  raw_fields: { Services: "HP Set-up Services", Timeline: "0–3 months", __submissionDateOrigin: "upload" },
  submitted_at: "2026-09-23T16:56:03.706Z", created_at: "2026-09-23T17:58:35Z",
  drive_modified_at: "2026-09-23T17:50:00Z", file_name: "original.csv",
  drive_file_id: "original_file_123", row_key: "row:2",
};
const second = { ...first, id: 2, file_name: "copied.csv", drive_file_id: "copied_file_456",
  submitted_at: "2026-09-23T16:56:02.881Z", created_at: "2026-09-23T17:58:40Z",
  affinity_reviews: { "HP Set-up Services": "approved" } };
const query = pool.query.bind(pool);
afterEach(() => vi.restoreAllMocks());

// Exercise the real loader SQL against entirely synthetic CTEs. No persisted reads/writes.
async function read(rows: Record<string, unknown>[], options: {
  tenantId?: number; clientId?: number; accountId?: number; contactId?: number; submissionId?: number;
} = {}) {
  vi.spyOn(pool, "query").mockImplementationOnce(((sql: string, values: unknown[]) => query(
    sql.replace("WITH requested AS", `WITH intent_inbound_submissions AS (
      SELECT * FROM jsonb_to_recordset($4::jsonb) AS x(
        id int,tenant_id int,client_id int,source_id int,account_id int,contact_id int,
        form_type text,product_interest text,purchase_timeframe_months int,classification text,
        explicit_interest boolean,requested_demo boolean,is_decision_maker boolean,
        affinity_reviews jsonb,identity_review text,routing_error text,routing_status text,raw_fields jsonb,
        submitted_at timestamptz,created_at timestamptz,drive_modified_at timestamptz,
        file_name text,drive_file_id text,row_key text)
    ), contacts AS (SELECT 50 id,10 tenant_id,20 client_id,40 company_id),
    companies AS (SELECT 40 id,10 tenant_id,20 client_id),
    intent_inbound_sources AS (SELECT 30 id,10 tenant_id,20 client_id,'GTM forms' name),
    requested AS`), [...values, JSON.stringify(rows)],
  )) as any);
  return readInboundProvenance(options.tenantId ?? 10, options.clientId ?? 20, [{
    submissionId: options.submissionId ?? 2, accountId: options.accountId ?? 40, contactId: options.contactId ?? 50,
  }]);
}

describe("read-only inbound copy provenance", () => {
  it("retains inspectable originals when spreadsheet formatting is normalized",async()=>{
    const original={...first,raw_fields:{...first.raw_fields,"Discussion\nwith HP":"Excellent"}};
    const copy={...second,raw_fields:{...second.raw_fields,"Discussion\r\nwith HP":" Excellent ","Empty cell":""}};
    expect((await read([original,copy])).get(2)!.copies.map(row=>row.submissionId)).toEqual([1,2]);
  });
  it("lists original files, source records and dates under the compatible review owner", async () => {
    const result = await read([first, second]);
    expect(result.size).toBe(1);
    expect(result.get(2)).toMatchObject({ retainedSubmissionId: 2, savedReviewCount: 1, copies: [
      { submissionId: 1, fileName: "original.csv", sourceName: "GTM forms", rowKey: "row:2", hasSavedReviews: false,
        fileUrl: "https://drive.google.com/file/d/original_file_123/view" },
      { submissionId: 2, fileName: "copied.csv", hasSavedReviews: true },
    ] });
    expect(result.get(2)!.copies[0].submittedAt).toContain("2026-09-23");
    expect(result.get(2)!.copies[0].importedAt).toContain("17:58:35");
    expect(result.get(2)!.copies[0].sourceModifiedAt).toContain("17:50:00");
    // Metadata only: no additional response rows or saved review contents.
    expect(result.get(2)!.copies[0]).not.toHaveProperty("raw_fields");
    expect(await read([first, second], { submissionId: 1 })).toEqual(new Map());
  });
  it.each(["tenant_id", "client_id", "source_id", "account_id", "contact_id"] as const)(
    "never exposes a copy across %s boundaries", async key => {
      const result = await read([first, second, { ...first, id: 3, [key]: 999 }]);
      expect(result.get(2)!.copies.map(c => c.submissionId)).toEqual([1, 2]);
    },
  );
  it.each([{ tenantId: 999 }, { clientId: 999 }, { accountId: 999 }, { contactId: 999 }])(
    "does not expose a retained response outside the requested ownership scope %j", async options => {
      expect(await read([first, second], options)).toEqual(new Map());
    },
  );
  it("keeps conflicting reviews, changed answers, dates, folders and identity blocks separate", async () => {
    const extra = [
      { ...first, id: 3, affinity_reviews: { "HP Set-up Services": "cold" } },
      { ...first, id: 4, raw_fields: { ...first.raw_fields, Timeline: "6 months" } },
      { ...first, id: 5, submitted_at: "2026-09-24T16:56:03Z" },
      { ...first, id: 6, routing_error: "Form email belongs to another account." },
      { ...first, id: 7, identity_review: "keep" },
      { ...first, id: 8, form_type: "lead_form" },
    ];
    expect((await read([first, second, ...extra])).get(2)!.copies.map(c => c.submissionId)).toEqual([1, 2]);
  });
  it("preserves real repeated submissions but includes exact source-date copies", async () => {
    const raw_fields = { ...first.raw_fields, __submissionDateOrigin: "source" };
    expect((await read([{ ...first, raw_fields }, { ...second, raw_fields }])).get(2)!.copies).toHaveLength(1);
    expect((await read([{ ...first, raw_fields }, { ...second, raw_fields, submitted_at: first.submitted_at }])).get(2)!.copies).toHaveLength(2);
  });
  it("does not manufacture file URLs for manual source identifiers", async () => {
    expect((await read([{ ...second, drive_file_id: "manual:account:40" }])).get(2)!.copies[0].fileUrl).toBeNull();
  });
  it("does no work for an empty page and supports HP mirror references without changing event IDs", async () => {
    const spy = vi.spyOn(pool, "query");
    expect(await readInboundProvenance(10, 20, [])).toEqual(new Map());
    expect(spy).not.toHaveBeenCalled();
    expect(inboundSubmissionId({ id: "hp:123", sourceSubmissionId: 2, externalEventId: "unchanged" })).toBe(2);
    expect(inboundSubmissionId({ id: "inbound:2:response" })).toBe(2);
    expect(inboundSubmissionId({ id: "hp:123", externalEventId: "inbound:2" })).toBe(2);
    expect(inboundSubmissionId({ id: "form:2" })).toBeNull();
  });
});
