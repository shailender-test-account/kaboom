import { pool } from "@workspace/db";

/** Bounded by the already authorized contact set; no per-contact requests. */
export async function contactRoutingMemberships(tenantId: number, ids: number[]) {
  const [journeys, sequences, opportunities] = await Promise.all([
    pool.query(`SELECT c.id AS "contactId",j.id,j.name,j.status,j.slug,
      COALESCE(jc.added_via,'company') AS "addedVia", COALESCE(jc.added_via='manual',false) AS removable
      FROM contacts c JOIN journeys j ON j.tenant_id=c.tenant_id AND j.client_id=c.client_id
      LEFT JOIN journey_contacts jc ON jc.journey_id=j.id AND jc.contact_id=c.id
      LEFT JOIN journey_companies co ON co.journey_id=j.id AND co.company_id=c.company_id
      WHERE c.tenant_id=$1 AND c.id=ANY($2::int[]) AND NOT c.is_anonymous
        AND (jc.contact_id IS NOT NULL OR co.company_id IS NOT NULL) ORDER BY j.name,j.id`, [tenantId, ids]),
    pool.query(`SELECT c.id AS "contactId",e.id,e.sequence_id AS "sequenceId",s.name AS "sequenceName",
      e.status,e.enrolled_at AS "enrolledAt" FROM contacts c JOIN sequence_enrollments e ON e.contact_id=c.id
      JOIN email_sequences s ON s.id=e.sequence_id AND s.tenant_id=c.tenant_id
      WHERE c.tenant_id=$1 AND c.id=ANY($2::int[]) AND NOT c.is_anonymous ORDER BY e.enrolled_at DESC,e.id DESC`, [tenantId, ids]),
    pool.query(`SELECT DISTINCT c.id AS "contactId",d.id,d.title,d.stage,COALESCE(d.contact_id=c.id,false) AS "isPrimary"
      FROM contacts c JOIN deals d ON d.tenant_id=c.tenant_id AND d.client_id=c.client_id AND d.company_id=c.company_id
      LEFT JOIN deal_contacts dc ON dc.deal_id=d.id AND dc.contact_id=c.id AND dc.tenant_id=c.tenant_id
        AND dc.client_id=c.client_id AND dc.company_id=c.company_id
      WHERE c.tenant_id=$1 AND c.id=ANY($2::int[]) AND NOT c.is_anonymous
        AND (d.contact_id=c.id OR dc.id IS NOT NULL) ORDER BY d.id`, [tenantId, ids]),
  ]);
  return {
    journeys: journeys.rows,
    enrollments: sequences.rows,
    opportunities: opportunities.rows,
  };
}

export async function linkContactOpportunity(tenantId: number, clientId: number, accountId: number,
  contactId: number, dealId: number, actorId: number | null) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT pg_advisory_xact_lock($1,914357)", [tenantId]);
    const owned = await tx.query(`SELECT d.id,d.contact_id FROM deals d JOIN contacts c
      ON c.tenant_id=d.tenant_id AND c.client_id=d.client_id AND c.company_id=d.company_id
      JOIN companies a ON a.id=c.company_id AND a.tenant_id=c.tenant_id AND a.client_id=c.client_id
      WHERE d.tenant_id=$1 AND d.client_id=$2 AND d.company_id=$3 AND c.id=$4 AND d.id=$5
        AND NOT c.is_anonymous FOR UPDATE OF c,d`, [tenantId, clientId, accountId, contactId, dealId]);
    if (!owned.rows.length) throw Object.assign(new Error("Choose an opportunity belonging to this contact's legal account."), { status: 404 });
    let added = false;
    if (Number(owned.rows[0].contact_id) !== contactId) {
      const link = await tx.query(`INSERT INTO deal_contacts(tenant_id,client_id,company_id,deal_id,contact_id,added_by)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,
      [tenantId, clientId, accountId, dealId, contactId, actorId]);
      added = !!link.rowCount;
      if (added) await tx.query(`INSERT INTO deal_audit(tenant_id,client_id,deal_id,actor_id,action,after)
        VALUES($1,$2,$3,$4,'contact_linked',$5::jsonb)`, [tenantId, clientId, dealId, actorId, JSON.stringify({ linkedContactId: contactId })]);
    }
    await tx.query("COMMIT");
    return { linked: true, added };
  } catch (err) { await tx.query("ROLLBACK"); throw err; }
  finally { tx.release(); }
}
