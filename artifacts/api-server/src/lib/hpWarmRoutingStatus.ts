import { pool } from "@workspace/db";
import { hpWarmOwnedSql, hpWarmRoutingPaused } from "./hpWarmRouting";
import { loadHpPriorityEvidence, priorityForAccounts } from "./hpAccountPriorityData";
import { isWarmNurtureContact, WARM_ONLY_ROUTING_MESSAGE } from "./hpNurturePolicy";
import { loadHpRoutingAudit } from "./hpRoutingAudit";

/** Live evidence is separate from the saved worker outcome. A roster is not consent or interest. */
export async function enrichHpRoutingRows(tenantId: number, clientId: number, rows: any[]) {
  if (!rows.length) return [];
  const owned = await pool.query(`WITH owned AS (${hpWarmOwnedSql})
    SELECT company_id,parent_key FROM owned WHERE parent_key=ANY($3::text[])`,
  [tenantId,clientId,rows.map(r => r.parentKey)]);
  const accountIds = owned.rows.map(r => Number(r.company_id));
  const [evidence, people] = await Promise.all([
    loadHpPriorityEvidence(tenantId,clientId,accountIds),
    pool.query(`SELECT * FROM (
      SELECT c.id,c.company_id AS "accountId",concat_ws(' ',c.first_name,c.last_name) AS name,
        c.dnc,c.status,c.email,
        EXISTS(SELECT 1 FROM intent_inbound_submissions s WHERE s.tenant_id=c.tenant_id
          AND s.client_id=c.client_id AND s.contact_id=c.id
          AND (s.account_id IS DISTINCT FROM c.company_id OR s.identity_review='keep'
            OR s.routing_error ILIKE '%email%another account%'
            OR EXISTS(SELECT 1 FROM jsonb_each_text(COALESCE(s.affinity_reviews,'{}'::jsonb)) a WHERE a.value='rejected'))) AS restricted,
        count(*) OVER(PARTITION BY c.company_id)::int AS total,
        row_number() OVER(PARTITION BY c.company_id ORDER BY c.id) AS rn
      FROM contacts c WHERE c.tenant_id=$1 AND c.client_id=$2
        AND c.company_id=ANY($3::int[]) AND NOT c.is_anonymous) people WHERE rn<=200`,
    [tenantId,clientId,accountIds]),
  ]);
  const routingDetails = await loadHpRoutingAudit(tenantId, clientId, accountIds, evidence);
  return rows.map(row => {
    const ids = new Set<number>(owned.rows.filter(a => a.parent_key===row.parentKey).map(a => Number(a.company_id)));
    const contacts = people.rows.filter(c => ids.has(Number(c.accountId))).map(c => {
      const products = [...new Set(evidence.forms.filter(f => f.contactId===Number(c.id)).map(f => f.product))];
      const reason = c.restricted ? "Identity or rejected product review requires attention"
        : c.dnc ? "Do not contact" : c.status!=="active" ? "Contact is not active"
        : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email ?? "") ? "Missing valid email"
        : !isWarmNurtureContact(Number(c.id),Number(c.accountId),evidence) ? WARM_ONLY_ROUTING_MESSAGE : "";
      return { id:Number(c.id),accountId:Number(c.accountId),name:c.name,products,eligible:!reason,reason };
    });
    return { ...row, routingDetails: routingDetails.filter(d => ids.has(d.accountId)),
      qualification:priorityForAccounts(evidence,ids).status,
      products:[...new Set(evidence.forms.filter(f => ids.has(f.accountId)).map(f => f.product))],
      contacts,contactCount:[...ids].reduce((n,id) => n+(people.rows.find(c => Number(c.accountId)===id)?.total ?? 0),0) };
  });
}

export async function loadHpWarmRoutingStatus(tenantId: number, clientId: number, status: string | undefined, after: string) {
  const [state, counts, items] = await Promise.all([
    pool.query(`SELECT cursor,last_success_at AS "lastSuccessAt",last_completed_at AS "lastCompletedAt",
      last_failure_at AS "lastFailureAt" FROM hp_warm_sweeps WHERE tenant_id=$1 AND client_id=$2`, [tenantId, clientId]),
    pool.query(`WITH owned AS (${hpWarmOwnedSql}), parents AS (SELECT DISTINCT parent_key FROM owned)
      SELECT COALESCE(ch.status,'unchecked') AS status,count(*)::int AS count
      FROM parents p LEFT JOIN hp_warm_checks ch ON ch.tenant_id=$1 AND ch.client_id=$2 AND ch.parent_key=p.parent_key
      GROUP BY COALESCE(ch.status,'unchecked')`, [tenantId, clientId]),
    pool.query(`WITH owned AS (${hpWarmOwnedSql}), parents AS (
      SELECT parent_key,string_agg(name,', ' ORDER BY name) AS name FROM owned GROUP BY parent_key)
      SELECT p.parent_key AS "parentKey",p.name,COALESCE(ch.status,'unchecked') AS status,
        COALESCE(ch.reason,'Awaiting the next sweep. No routing decision has been recorded.') AS reason,
        COALESCE(ch.journeys,'[]'::jsonb) AS journeys,ch.checked_at AS "checkedAt"
      FROM parents p LEFT JOIN hp_warm_checks ch ON ch.tenant_id=$1 AND ch.client_id=$2 AND ch.parent_key=p.parent_key
      WHERE p.parent_key>$3 AND ($4::text IS NULL OR COALESCE(ch.status,'unchecked')=$4)
      ORDER BY p.parent_key LIMIT 51`, [tenantId, clientId, after, status ?? null]),
  ]);
  const rows = items.rows.slice(0, 50);
  return { paused: hpWarmRoutingPaused(),
    sweep: state.rows[0] ?? { cursor: "", lastSuccessAt: null, lastCompletedAt: null, lastFailureAt: null },
    counts: Object.fromEntries(counts.rows.map(row => [row.status, row.count])),
    items: await enrichHpRoutingRows(tenantId,clientId,rows), nextCursor: items.rows.length > 50 ? rows.at(-1)!.parentKey : null };
}
