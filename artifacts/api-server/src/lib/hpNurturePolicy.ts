import { pool } from "@workspace/db";
import type { PoolClient } from "pg";
import { hpClientNameSql } from "./hpClientScope";
import { calculateAccountPriority, type PriorityForm, type PriorityActivity, type PrioritySignal } from "./hpAccountPriority";

export const WARM_ONLY_ROUTING_MESSAGE =
  "Only currently Warm contacts may enter a journey or nurture sequence. Hot contacts are for telecaller follow-up; Cold contacts are not eligible.";

/** Evaluate the person, not the hottest colleague or the account roll-up. */
export function isWarmNurtureContact(
  contactId: number, accountId: number,
  evidence: { forms: PriorityForm[]; activities: PriorityActivity[]; signals: PrioritySignal[] },
  now = new Date(),
) {
  const priority = calculateAccountPriority(
    evidence.forms.filter(f => f.accountId === accountId && f.contactId === contactId),
    evidence.activities.filter(a => a.accountId === accountId && a.contactId === contactId),
    evidence.signals.filter(s => s.accountId === accountId), now,
  );
  // An explicit Hot declaration wins over another Warm response for this person.
  return priority.declaredQualification !== "Hot" && priority.status === "Warm";
}

/** Used at both admission and delivery; never modifies history or starts calls. */
export async function hpContactMayNurture(
  tenantId: number, clientId: number, contactId: number,
  executor: Pick<PoolClient, "query"> = pool,
) {
  const owner = await executor.query(`SELECT ${hpClientNameSql("cl.name")} AS hp,c.company_id
    FROM clients cl LEFT JOIN contacts c ON c.tenant_id=cl.tenant_id AND c.client_id=cl.id AND c.id=$3
    WHERE cl.tenant_id=$1 AND cl.id=$2`, [tenantId, clientId, contactId]);
  if (!owner.rows[0]) return false;
  if (!owner.rows[0].hp) return true;
  const accountId = Number(owner.rows[0].company_id);
  if (!accountId) return false;
  // Lazy import avoids the inbound-import / priority-evidence dependency cycle.
  const { loadHpPriorityEvidence } = await import("./hpAccountPriorityData");
  const now = new Date();
  const evidence = await loadHpPriorityEvidence(tenantId, clientId, [accountId], now, true, executor);
  return !evidence.blockedContacts.has(contactId) && isWarmNurtureContact(contactId, accountId, evidence, now);
}
