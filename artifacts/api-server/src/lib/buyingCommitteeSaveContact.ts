import { pool } from "@workspace/db";
import { committeeError, requireHpCommitteeClient } from "./buyingCommittee";
import { committeeCountry } from "./buyingCommitteeCountry";

/** Explicit CRM promotion only. Never route, enroll, send or award engagement. */
export async function saveCommitteeContact(tenantId: number, input: {
  clientId: number; companyId: number; prospectId: number;
}) {
  await requireHpCommitteeClient(tenantId, input.clientId);
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    // Share deletion/import serialization, so a stale card cannot resurrect a deleted company.
    await connection.query("SELECT pg_advisory_xact_lock($1::int,914357)", [tenantId]);
    const company = await connection.query(`SELECT name FROM companies
      WHERE tenant_id=$1 AND client_id=$2 AND id=$3 FOR UPDATE`,
    [tenantId, input.clientId, input.companyId]);
    if (!company.rowCount) committeeError("This account is no longer available. Refresh the account card.", 404);
    const source = await connection.query(`SELECT * FROM buying_committee_contacts
      WHERE tenant_id=$1 AND client_id=$2 AND company_id=$3 AND id=$4 FOR UPDATE`,
    [tenantId, input.clientId, input.companyId, input.prospectId]);
    if (!source.rowCount) committeeError("This sourced contact is no longer available.", 404);
    const p = source.rows[0];
    const identifier = `buying-committee:${p.id}`;
    const email = p.email?.trim() || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      committeeError("The sourced email is invalid. Review the contact before adding it.");
    }
    const matched = await connection.query(`SELECT * FROM contacts WHERE tenant_id=$1 AND
      (identifier=$2 OR ($3::text IS NOT NULL AND lower(btrim(email))=lower($3))
        OR ($4::text IS NOT NULL AND NULLIF(btrim(linkedin_url),'')=$4))
      ORDER BY id FOR UPDATE`, [tenantId, identifier, email, p.linkedin?.trim() || null]);
    if (matched.rows.length > 1) committeeError("Multiple database contacts match this person. Review duplicates in Contacts before adding.", 409);
    const existing = matched.rows[0];
    if (existing && (existing.client_id !== input.clientId || existing.company_id !== input.companyId || existing.is_anonymous)) {
      committeeError("This identity belongs to another account or needs identity review. Existing records were not changed.", 409);
    }
    const parts = String(p.name).trim().split(/\s+/);
    const first = parts.shift() || null, last = parts.join(" ") || null;
    let country: string|null = null;
    try { country = committeeCountry(p.location?.split(",").at(-1)?.trim()) ?? null; } catch { /* Historical location may not contain a verified country. */ }
    let contactId: number;
    if (existing) {
      // Fill gaps only. Preserve corrections, DNC, status, intent, historical ownership and routing.
      await connection.query(`UPDATE contacts SET
        first_name=COALESCE(NULLIF(btrim(first_name),''),$3),
        last_name=COALESCE(NULLIF(btrim(last_name),''),$4),
        email=COALESCE(NULLIF(btrim(email),''),$5),
        phone=COALESCE(NULLIF(btrim(phone),''),$6),
        title=COALESCE(NULLIF(btrim(title),''),$7),
        designation=COALESCE(NULLIF(btrim(designation),''),$7),
        linkedin_url=COALESCE(NULLIF(btrim(linkedin_url),''),$8),
        identifier=COALESCE(NULLIF(btrim(identifier),''),$9),updated_at=NOW()
        WHERE tenant_id=$1 AND id=$2`,
      [tenantId, existing.id, first, last, email, p.phone, p.title, p.linkedin, identifier]);
      contactId = existing.id;
    } else {
      const saved = await connection.query(`INSERT INTO contacts
        (tenant_id,client_id,company_id,company_name,first_name,last_name,email,phone,title,designation,
          linkedin_url,country,identifier,source,tags,lead_score,intent_score)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12,'buying_committee',ARRAY['Buying Committee'],0,0)
        RETURNING id`, [tenantId, input.clientId, input.companyId, company.rows[0].name,
        first, last, email, p.phone, p.title, p.linkedin,
        country, identifier]);
      contactId = saved.rows[0].id;
    }
    await connection.query("COMMIT");
    return { contactId, created: !existing };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally { connection.release(); }
}
