import { pool } from "@workspace/db";

export function resolveSubmissionDate(sourceDate: Date | null, previous?: {
  submitted_at?: Date | null; created_at?: Date; raw_fields?: Record<string, unknown>;
}, uploadedAt?: string) {
  const override = previous?.raw_fields?.__submissionDateOverride;
  const uploadDate = uploadedAt && Number.isFinite(Date.parse(uploadedAt)) ? new Date(uploadedAt) : null;
  return {
    submittedAt: override ? new Date(String(override)) : sourceDate ?? previous?.submitted_at ??
      uploadDate ?? previous?.created_at ?? new Date(),
    dateMetadata: override
      ? Object.fromEntries(Object.entries(previous?.raw_fields ?? {}).filter(([key]) => key.startsWith("__submissionDate")))
      : { __submissionDateOrigin: sourceDate ? "source" : previous?.raw_fields?.__submissionDateOrigin ??
        (previous?.submitted_at ? "source" : "upload") },
  };
}

/** A date entered by a user is an India calendar business day. */
export function submissionDate(value: string) {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw Object.assign(new Error("Enter a valid submission date (YYYY-MM-DD)."), { status: 400 });
  }
  return new Date(`${value}T00:00:00+05:30`);
}

export async function editInboundSubmissionDate(tenantId: number, id: number, value: string, userId: number) {
  const date = submissionDate(value);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::int,914357)", [tenantId]);
    const result = await client.query(`UPDATE intent_inbound_submissions
      SET submitted_at=$3,raw_fields=COALESCE(raw_fields,'{}'::jsonb) ||
        jsonb_build_object('__submissionDateOverride',$3::timestamptz,
          '__submissionDateEditedBy',$4::int,'__submissionDateEditedAt',NOW()),updated_at=NOW()
      WHERE tenant_id=$1 AND id=$2 RETURNING client_id,submitted_at`, [tenantId, id, date, userId]);
    if (!result.rowCount) throw Object.assign(new Error("Response not found."), { status: 404 });
    // Keep captured BI records and deferred captures on the corrected date too.
    await client.query(`UPDATE hp_bi_records SET occurred_at=$4 WHERE tenant_id=$1 AND client_id=$2
      AND source_key IN ($3,$3||':response')`, [tenantId, result.rows[0].client_id, `inbound:${id}`, date]);
    await client.query(`UPDATE hp_bi_matches SET payload=payload || jsonb_build_object('occurredAt',$4::timestamptz)
      WHERE tenant_id=$1 AND client_id=$2 AND source_key=$3 AND resolved_account_id IS NULL`,
    [tenantId, result.rows[0].client_id, `inbound:${id}`, date]);
    await client.query("COMMIT");
    return { submittedAt: date.toISOString() };
  } catch (err) { await client.query("ROLLBACK"); throw err; }
  finally { client.release(); }
}
