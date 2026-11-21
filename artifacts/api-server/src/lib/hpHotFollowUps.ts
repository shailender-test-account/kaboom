import { pool } from "@workspace/db";
import { createHash } from "node:crypto";
import { formState, type PriorityForm } from "./hpAccountPriority";
import { loadHpPriorityEvidence, type HpPriorityEvidence } from "./hpAccountPriorityData";
import { hpClientNameSql } from "./hpClientScope";
import { logger } from "./logger";
import type { PoolClient } from "pg";

/** Account heat, research and sibling behaviour never qualify a person for calling. */
export function hotContactEvidence(data: Pick<HpPriorityEvidence, "forms" | "blockedContacts">, now = new Date()) {
  const people = new Map<number, PriorityForm[]>();
  for (const form of data.forms) {
    if (!form.contactId || data.blockedContacts.has(form.contactId) || !formState(form, now).explicit) continue;
    people.set(form.contactId, [...(people.get(form.contactId) ?? []), form]);
  }
  return people;
}

// Both the unified suppression flag and the call-specific negative list apply.
export const hotContactAllowedSql = `NOT ct.is_anonymous AND NOT ct.dnc AND ct.status='active'
  AND NOT EXISTS(SELECT 1 FROM call_dnc_contacts d WHERE d.tenant_id=ct.tenant_id AND d.contact_id=ct.id)`;

/** Bounded batches; no call, email, enrollment, or provider side effects. */
export async function syncHotFollowUps(tenantId: number, clientId: number, accountIds: number[], now = new Date(),
  afterSync?: (db: PoolClient) => Promise<void>) {
  if (!accountIds.length) return;
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    // Same lock as CRM identity/deletion writers. Re-read identity before every insert.
    await db.query("SELECT pg_advisory_xact_lock($1,914357)", [tenantId]);
    const owned = (await db.query(`SELECT c.id FROM companies c JOIN clients cl ON cl.id=c.client_id AND cl.tenant_id=c.tenant_id
      WHERE c.tenant_id=$1 AND c.client_id=$2 AND c.id=ANY($3::int[]) AND ${hpClientNameSql("cl.name")}`,
      [tenantId, clientId, accountIds])).rows.map(r => Number(r.id));
    const evidence = await loadHpPriorityEvidence(tenantId, clientId, owned, now, false, db);
    const people = hotContactEvidence(evidence, now);
    const eligible: number[] = [];
    for (const [contactId, forms] of people) {
      // Stable across reimports/reads; completion survives unchanged qualification.
      const latest = [...forms].sort((a, b) => b.at.localeCompare(a.at) || b.reference.localeCompare(a.reference) || b.product.localeCompare(a.product))[0];
      const key = createHash("sha256").update(JSON.stringify(
        [latest.product, latest.months, latest.at])).digest("hex");
      const inserted = await db.query(`INSERT INTO hp_hot_follow_ups(tenant_id,client_id,account_id,contact_id,evidence,evidence_key)
        SELECT $1,$2,ct.company_id,ct.id,$4::jsonb,$5 FROM contacts ct JOIN companies c
        ON c.id=ct.company_id AND c.tenant_id=ct.tenant_id AND c.client_id=ct.client_id
        WHERE ct.tenant_id=$1 AND ct.client_id=$2 AND ct.id=$3 AND ct.company_id=$6 AND ${hotContactAllowedSql}
        ON CONFLICT(tenant_id,contact_id) DO UPDATE SET client_id=EXCLUDED.client_id,account_id=EXCLUDED.account_id,
        evidence=EXCLUDED.evidence,evidence_key=EXCLUDED.evidence_key,updated_at=NOW(),
        status=CASE WHEN hp_hot_follow_ups.completed_at IS NOT NULL AND hp_hot_follow_ups.evidence_key=EXCLUDED.evidence_key
          THEN 'completed' ELSE 'open' END,
        completed_at=CASE WHEN hp_hot_follow_ups.evidence_key=EXCLUDED.evidence_key THEN hp_hot_follow_ups.completed_at END,
        completed_by=CASE WHEN hp_hot_follow_ups.evidence_key=EXCLUDED.evidence_key THEN hp_hot_follow_ups.completed_by END,
        completion_note=CASE WHEN hp_hot_follow_ups.evidence_key=EXCLUDED.evidence_key THEN hp_hot_follow_ups.completion_note END,
        assignee_id=CASE WHEN hp_hot_follow_ups.client_id=EXCLUDED.client_id AND hp_hot_follow_ups.account_id=EXCLUDED.account_id
          THEN hp_hot_follow_ups.assignee_id END RETURNING contact_id`,
        [tenantId, clientId, contactId, JSON.stringify(forms), key, forms[0].accountId]);
      if (inserted.rowCount) eligible.push(contactId);
    }
    await db.query(`UPDATE hp_hot_follow_ups SET status='ineligible',updated_at=NOW()
      WHERE tenant_id=$1 AND client_id=$2 AND account_id=ANY($3::int[]) AND status<>'ineligible'
      AND NOT(contact_id=ANY($4::int[]))`, [tenantId, clientId, accountIds, eligible]);
    if (afterSync) await afterSync(db);
    await db.query("COMMIT");
  } catch (err) { await db.query("ROLLBACK"); throw err; }
  finally { db.release(); }
}

export function startHotFollowUpRunner() {
  let busy = false;
  const cursors = new Map<number, number>();
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const clients = (await pool.query(`SELECT id,tenant_id FROM clients WHERE ${hpClientNameSql("name")}`)).rows;
      for (const cl of clients) {
        const ids = (await pool.query(`SELECT id FROM companies WHERE tenant_id=$1 AND client_id=$2 AND id>$3 ORDER BY id LIMIT 100`,
          [cl.tenant_id, cl.id, cursors.get(cl.id) ?? 0])).rows.map(r => Number(r.id));
        await syncHotFollowUps(cl.tenant_id, cl.id, ids);
        cursors.set(cl.id, ids.length === 100 ? ids.at(-1)! : 0);
      }
    } catch (err) { logger.error({ err }, "HP Hot follow-up sweep failed; will retry"); }
    finally { busy = false; }
  };
  void tick();
  setInterval(() => void tick(), 60_000).unref();
}
