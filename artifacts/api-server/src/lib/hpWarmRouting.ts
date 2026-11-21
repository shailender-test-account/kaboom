import { pool } from "@workspace/db";
import { matchingInboundRoutingRule, routePendingWarmSubmissions, type InboundRoutingRule } from "./inboundAccounts";
import { loadInboundCategoryRules } from "./inboundTaxonomy";
import { loadHpPriorityEvidence, priorityForAccounts, warmRoutingCandidates, type HpPriorityEvidence } from "./hpAccountPriorityData";
import type { AccountPriority } from "./hpAccountPriority";
import { logger } from "./logger";
import { hpClientNameSql } from "./hpClientScope";
import { enrollHpRuleSequence, hpRuleSequenceEnabled } from "./hpRuleSequence";
import { hpContactMayNurture } from "./hpNurturePolicy";

/** Explicitly enable only this approved journey-membership worker, never outbound runners. */
export const hpWarmRoutingPaused = () => process.env.COPIED_DATA_SAFE_MODE === "true"
  && process.env.HP_WARM_JOURNEY_ROUTING_ENABLED !== "true" && !hpRuleSequenceEnabled();

export const hpWarmOwnedSql = `SELECT p.company_id,c.name,CASE WHEN p.dimensions ? '_rosterAssociation' AND rp.company_id IS NULL
      THEN COALESCE(p.dimensions->'_rosterAssociation'->>'previousParentKey',p.parent_key)
      ELSE COALESCE(rp.parent_key,p.parent_key) END AS parent_key
    FROM hp_account_profiles p JOIN companies c ON c.id=p.company_id AND c.tenant_id=p.tenant_id AND c.client_id=p.client_id
    LEFT JOIN hp_account_profiles rp ON rp.tenant_id=p.tenant_id AND rp.client_id=p.client_id AND rp.hp_id IS NOT NULL
      AND rp.company_id=CASE WHEN p.dimensions->'_rosterAssociation'->>'accountId' ~ '^[0-9]{1,9}$'
        THEN (p.dimensions->'_rosterAssociation'->>'accountId')::int END
    JOIN clients cl ON cl.id=p.client_id AND cl.tenant_id=p.tenant_id AND ${hpClientNameSql("cl.name")}
    WHERE p.tenant_id=$1 AND p.client_id=$2`;

/** Enabled, explicitly product/category-matched mappings only. Never a catch-all. */
export async function loadHpWarmRouting(tenantId: number, clientId: number, ids: number[]) {
  const [rules, contacts, categoryRules] = await Promise.all([
    pool.query<InboundRoutingRule & { journey_name: string; journey_status:string; sequence_status:string; sequence_client_id:number }>(`SELECT r.*,j.name AS journey_name,
      j.status AS journey_status,es.status AS sequence_status,es.client_id AS sequence_client_id,
      COALESCE(r.inbound_product_name,p.name) AS product_name,COALESCE(r.inbound_category_name,pc.name) AS category_name
      FROM intent_inbound_routing_rules r JOIN journeys j
        ON j.id=r.journey_id AND j.tenant_id=r.tenant_id AND j.client_id=r.client_id
      LEFT JOIN intent_products p ON p.id=r.product_id AND p.tenant_id=r.tenant_id
      LEFT JOIN intent_product_categories pc ON pc.id=r.category_id AND pc.tenant_id=r.tenant_id
      LEFT JOIN email_sequences es ON es.id=r.sequence_id AND es.tenant_id=r.tenant_id
      WHERE r.tenant_id=$1 AND r.client_id=$2 AND (r.enabled OR $3::boolean)
        AND r.classification IN ('warm','all')
        AND (r.match_type IN ('product','category') OR ($3::boolean AND r.match_type='fallback'))
        AND (j.status='published' OR $3::boolean) ORDER BY r.priority,r.id`,
    [tenantId, clientId,hpRuleSequenceEnabled()]),
    pool.query(`SELECT c.id,c.company_id,
      ARRAY(SELECT se.sequence_id FROM sequence_enrollments se JOIN email_sequences es ON es.id=se.sequence_id
        WHERE se.contact_id=c.id AND es.tenant_id=c.tenant_id AND es.client_id=c.client_id) AS sequences,
      COALESCE(array_agg(jc.journey_id) FILTER(WHERE jc.journey_id IS NOT NULL),'{}') AS journeys
      FROM contacts c LEFT JOIN journey_contacts jc ON jc.contact_id=c.id
      LEFT JOIN journeys j ON j.id=jc.journey_id AND j.tenant_id=c.tenant_id AND j.client_id=c.client_id
      WHERE c.tenant_id=$1 AND c.client_id=$2 AND c.company_id=ANY($3::int[])
      AND NOT c.is_anonymous AND NOT c.dnc AND c.status='active'
      AND c.email ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'
      GROUP BY c.id`, [tenantId, clientId, ids]),
    loadInboundCategoryRules(tenantId),
  ]);
  const eligible = new Map(contacts.rows.map(c => [Number(c.id), c]));
  const ready = (rule: InboundRoutingRule | undefined): rule is InboundRoutingRule => {
    if (!rule?.journey_id) return false;
    const r = rule as typeof rules.rows[number];
    return r.enabled !== false && (!hpRuleSequenceEnabled()
      || r.journey_status==="published" && r.sequence_status==="active" && r.sequence_client_id===clientId);
  };
  return {
    check(data: HpPriorityEvidence, accountIds: Set<number>, now: Date) {
      const priority = priorityForAccounts(data, accountIds, now);
      const journeys: string[] = [];
      if (!priority.warmForm && priority.status !== "Warm")
        return { status: "not_eligible", reason: "Not currently Warm. Review current purchase declarations and priority evidence.", journeys };
      const candidates = warmRoutingCandidates(data, accountIds, now);
      if (!candidates.length) return { status: "blocked",
        reason: "No attributable contact with current product evidence. Review identity restrictions, rejected answers and expired purchase windows.", journeys };
      let blocked = false, unmapped = false, pending = false;
      const missingProducts = new Set<string>();
      for (const candidate of candidates) {
        const contact = eligible.get(candidate.contactId);
        if (!contact || Number(contact.company_id) !== candidate.accountId) { blocked = true; continue; }
        const rule = matchingInboundRoutingRule(rules.rows, clientId, candidate.product, "warm", [], candidate.overrides, categoryRules);
        if (!ready(rule)) { unmapped = true; missingProducts.add(candidate.product); continue; }
        journeys.push((rule as typeof rules.rows[number]).journey_name);
        if (!contact.journeys.map(Number).includes(rule.journey_id)) pending = true;
        if (hpRuleSequenceEnabled() && !contact.sequences.map(Number).includes(rule.sequence_id)) pending = true;
      }
      return { status: unmapped ? "unmapped" : blocked || pending ? "blocked" : "routed",
        reason: [
          unmapped ? `Enable an explicit product/category Warm mapping for ${[...missingProducts].join(", ")} to a published, same-client journey${hpRuleSequenceEnabled() ? " and active sequence. Draft-specific mappings are not redirected to a fallback" : ""}.` : "",
          blocked ? "Review DNC, active status, valid email and contact ownership. Do not override opt-outs." : "",
          pending ? hpWarmRoutingPaused() ? "Copied-data safe mode pauses automatic membership." : "Membership is pending or a write-time safeguard blocked it; review the contact, rule and identity restrictions." : "",
          !unmapped && !blocked && !pending ? hpRuleSequenceEnabled()
            ? "Eligible product contacts have journey membership and a sequence enrollment. Historical enrollments are retained, never restarted."
            : "All eligible product contacts are in their approved journeys. No email sequence enrollment." : "",
        ].filter(Boolean).join(" "), journeys: [...new Set(journeys)] };
    },
    matches(data: HpPriorityEvidence, accountIds: Set<number>, now: Date) {
      const seen = new Set<string>();
      return warmRoutingCandidates(data, accountIds, now).flatMap(candidate => {
        const contact = eligible.get(candidate.contactId);
        if (!contact || Number(contact.company_id) !== candidate.accountId) return [];
        const rule = matchingInboundRoutingRule(rules.rows, clientId, candidate.product, "warm", [], candidate.overrides, categoryRules);
        if (!ready(rule)) return [];
        const key = `${candidate.contactId}:${rule.journey_id}:${hpRuleSequenceEnabled() ? rule.sequence_id : ""}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ ...candidate, journeyId: rule.journey_id, ruleId: rule.id,
          journeyName: (rule as typeof rules.rows[number]).journey_name,
          active: contact.journeys.map(Number).includes(rule.journey_id),
          sequenceAssigned: contact.sequences.map(Number).includes(rule.sequence_id) }];
      });
    },
    describe(priority: AccountPriority, data: HpPriorityEvidence, accountIds: Set<number>, now: Date) {
      if (!priority.warmForm && priority.status !== "Warm") return priority.routing;
      const matches = this.matches(data, accountIds, now);
      if (!matches.length) return priority.routing;
      const active = matches.every(m => m.active && (!hpRuleSequenceEnabled() || m.sequenceAssigned));
      if (!active && hpWarmRoutingPaused())
        return { status: "Needs attention" as const, reason: "Automatic routing is paused by copied-data safe mode. No contacts will be enrolled in this environment.",
          journeys: [...new Set(matches.map(m => m.journeyName))] };
      return { status: active ? "Active" as const : "Ready" as const,
        reason: hpRuleSequenceEnabled()
          ? active ? "Relevant contacts have journey membership and a sequence enrollment; existing enrollments are never restarted."
            : "Eligible contacts await automatic routing to the rule's published journey and active sequence."
          : active ? "Relevant contacts are in the approved journey. No automatic sequence sending."
            : "Eligible contacts await the automatic routing check. No automatic sequence sending.",
        journeys: [...new Set(matches.map(m => m.journeyName))] };
    },
  };
}

/** Journey-only by default; sequences require the independently approved switch. */
export async function routeHpWarmBatch(tenantId: number, clientId: number, after = "", limit = 100) {
  if (hpWarmRoutingPaused()) return { cursor: after, routed: 0, checks: [] };
  limit = Math.max(1, Math.min(100, Math.trunc(limit) || 100));
  const groups = await pool.query(`WITH owned AS (${hpWarmOwnedSql})
    SELECT parent_key,array_agg(company_id) AS ids FROM owned WHERE parent_key>$3
    GROUP BY parent_key ORDER BY parent_key LIMIT $4`, [tenantId, clientId, after, limit]);
  const ids = groups.rows.flatMap(r => r.ids.map(Number));
  if (!ids.length) return { cursor: "", routed: 0, checks: [] };
  const now = new Date();
  const data = await loadHpPriorityEvidence(tenantId, clientId, ids, now);
  const routing = await loadHpWarmRouting(tenantId, clientId, ids);
  let routed = 0;
  for (const group of groups.rows) {
    const accountIds = new Set<number>(group.ids.map(Number));
    const priority = priorityForAccounts(data, accountIds, now);
    if (!priority.warmForm && priority.status !== "Warm") continue;
    for (const match of routing.matches(data, accountIds, now)
      .filter(m => !m.active || hpRuleSequenceEnabled() && !m.sequenceAssigned)) {
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        // Same boundary as CRM deletion and existing inbound routing.
        await db.query("SELECT pg_advisory_xact_lock($1::int,914357)", [tenantId]);
        if (!await hpContactMayNurture(tenantId,clientId,match.contactId,db)) {
          await db.query("ROLLBACK");
          continue;
        }
        // Revalidate the actual product mapping under a row lock. An admin may
        // have edited the rule after the batch loaded its candidates.
        const current = await db.query(`SELECT r.*,COALESCE(r.inbound_product_name,p.name) AS product_name,
          COALESCE(r.inbound_category_name,pc.name) AS category_name FROM intent_inbound_routing_rules r
          LEFT JOIN intent_products p ON p.id=r.product_id AND p.tenant_id=r.tenant_id
          LEFT JOIN intent_product_categories pc ON pc.id=r.category_id AND pc.tenant_id=r.tenant_id
          WHERE r.id=$1 AND r.tenant_id=$2 AND r.client_id=$3 AND r.enabled
            AND r.classification IN ('warm','all')
            AND (r.match_type IN ('product','category') OR ($4::boolean AND r.match_type='fallback')) FOR SHARE OF r`,
        [match.ruleId, tenantId, clientId,hpRuleSequenceEnabled()]);
        if (!matchingInboundRoutingRule(current.rows, clientId, match.product, "warm", [], match.overrides,
          await loadInboundCategoryRules(tenantId))) {
          await db.query("COMMIT");
          continue;
        }
        const inserted = await db.query(`INSERT INTO journey_contacts(journey_id,contact_id,added_via)
          SELECT r.journey_id,c.id,'hp_warm_priority'
          FROM contacts c JOIN companies co ON co.id=c.company_id AND co.tenant_id=c.tenant_id AND co.client_id=c.client_id
          JOIN intent_inbound_routing_rules r ON r.id=$4 AND r.tenant_id=c.tenant_id AND r.client_id=c.client_id
          JOIN journeys j ON j.id=r.journey_id AND j.tenant_id=r.tenant_id AND j.client_id=r.client_id
          WHERE c.tenant_id=$1 AND c.client_id=$2 AND c.id=$3 AND c.company_id=$5
          AND NOT c.dnc AND NOT c.is_anonymous AND c.status='active' AND r.enabled AND j.status='published'
          AND c.email ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'
          AND r.journey_id=$6 AND r.classification IN ('warm','all')
          AND (r.match_type IN ('product','category') OR ($8::boolean AND r.match_type='fallback'))
          AND NOT EXISTS(SELECT 1 FROM intent_inbound_submissions s WHERE s.tenant_id=c.tenant_id
            AND s.client_id=c.client_id AND s.contact_id=c.id AND s.account_id=c.company_id
            AND (s.identity_review='keep' OR s.routing_error ILIKE '%email%another account%'
              OR s.affinity_reviews->>$7='rejected'))
          AND NOT EXISTS(SELECT 1 FROM journey_contacts jc WHERE jc.journey_id=r.journey_id AND jc.contact_id=c.id)
          RETURNING contact_id`, [tenantId, clientId, match.contactId, match.ruleId, match.accountId, match.journeyId, match.product,hpRuleSequenceEnabled()]);
        // Sequence admission shares the membership transaction. A changed
        // destination or failed safeguard rolls both writes back.
        if (hpRuleSequenceEnabled()) {
          const admitted = await db.query(`SELECT c.id FROM contacts c
            WHERE c.tenant_id=$1 AND c.client_id=$2 AND c.id=$3 AND c.company_id=$4
              AND NOT c.dnc AND NOT c.is_anonymous AND c.status='active'
              AND NOT EXISTS(SELECT 1 FROM intent_inbound_submissions s WHERE s.tenant_id=c.tenant_id
                AND s.client_id=c.client_id AND s.contact_id=c.id
                AND (s.account_id IS DISTINCT FROM c.company_id OR s.identity_review='keep'
                  OR s.routing_error ILIKE '%email%another account%' OR s.affinity_reviews->>$5='rejected'))
              AND EXISTS(SELECT 1 FROM journey_contacts jc WHERE jc.contact_id=c.id AND jc.journey_id=$6)
            FOR SHARE OF c`,[tenantId,clientId,match.contactId,match.accountId,match.product,match.journeyId]);
          if (admitted.rowCount) await enrollHpRuleSequence(db,tenantId,clientId,match.contactId,match.ruleId,[match.product]);
        }
        if (inserted.rowCount) {
          await db.query(`INSERT INTO activity_events(tenant_id,client_id,company_id,contact_id,journey_id,event_type,description,metadata,points_earned)
            VALUES($1,$2,$3,$4,$5,'hp_warm_routed','Automatically added to approved Warm journey',$6,0)`,
          [tenantId, clientId, match.accountId, match.contactId, match.journeyId,
            JSON.stringify({ ruleId: match.ruleId, product: match.product, score: priority.score, reason: priority.warmForm ? "Warm form" : "Overall Warm", policy: "hp-priority-v1" })]);
          routed++;
        }
        await db.query("COMMIT");
      } catch (err) { await db.query("ROLLBACK"); throw err; }
      finally { db.release(); }
    }
  }
  const refreshed = await loadHpWarmRouting(tenantId, clientId, ids);
  const checks = groups.rows.map(group => ({ parentKey: String(group.parent_key),
    ...refreshed.check(data, new Set<number>(group.ids.map(Number)), now) }));
  return { cursor: groups.rows.length === limit ? groups.rows.at(-1)!.parent_key as string : "", routed, checks };
}

/** A session lock fences progress across processes; crashes release it automatically.
 * Membership writes are idempotent, so retrying a partially completed batch is safe.
 */
export async function runHpWarmSweep(tenantId: number, clientId: number, limit = 100) {
  if (hpWarmRoutingPaused()) return;
  const db = await pool.connect();
  let locked = false;
  try {
    locked = (await db.query("SELECT pg_try_advisory_lock(714035,$1::int) AS locked", [clientId])).rows[0].locked;
    if (!locked) return;
    const state = await db.query(`INSERT INTO hp_warm_sweeps(tenant_id,client_id)
      SELECT tenant_id,id FROM clients WHERE tenant_id=$1 AND id=$2 AND ${hpClientNameSql("name")}
      ON CONFLICT(tenant_id,client_id) DO UPDATE SET client_id=excluded.client_id RETURNING cursor`, [tenantId, clientId]);
    if (!state.rowCount) return;
    const result = await routeHpWarmBatch(tenantId, clientId, state.rows[0].cursor, limit);
    if (hpWarmRoutingPaused()) return;
    await db.query("BEGIN");
    for (const check of result.checks) await db.query(`INSERT INTO hp_warm_checks
      (tenant_id,client_id,parent_key,status,reason,journeys,checked_at) VALUES($1,$2,$3,$4,$5,$6,NOW())
      ON CONFLICT(tenant_id,client_id,parent_key) DO UPDATE SET status=excluded.status,
        reason=excluded.reason,journeys=excluded.journeys,checked_at=excluded.checked_at`,
    [tenantId, clientId, check.parentKey, check.status, check.reason, JSON.stringify(check.journeys)]);
    await db.query(`UPDATE hp_warm_sweeps SET cursor=$3,last_success_at=NOW(),
      last_completed_at=CASE WHEN $3='' THEN NOW() ELSE last_completed_at END,last_failure_at=NULL
      WHERE tenant_id=$1 AND client_id=$2`, [tenantId, clientId, result.cursor]);
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK");
    if (locked) await db.query("UPDATE hp_warm_sweeps SET last_failure_at=NOW() WHERE tenant_id=$1 AND client_id=$2", [tenantId, clientId]);
    throw err;
  } finally {
    try {
      if (locked) await db.query("SELECT pg_advisory_unlock(714035,$1::int)", [clientId]);
    } finally { db.release(); }
  }
}

export async function loadHpWarmClients() {
  return (await pool.query(`SELECT id,tenant_id FROM clients WHERE ${hpClientNameSql("name")} ORDER BY id`)).rows;
}

export function startHpWarmRoutingRunner() {
  let busy = false;
  const tick = async () => {
    if (busy || hpWarmRoutingPaused()) return;
    busy = true;
    try {
      const clients = await loadHpWarmClients();
      for (const client of clients) {
        try {
          if (hpRuleSequenceEnabled()) {
            const pending = await routePendingWarmSubmissions(Number(client.tenant_id),undefined,undefined,Number(client.id));
            if (pending.routed || pending.failed) logger.info({clientId:client.id,...pending}, "HP published-rule routing check");
          }
          const result = await runHpWarmSweep(Number(client.tenant_id), Number(client.id));
          if (result?.routed) logger.info({ clientId: client.id, routed: result.routed }, "HP Warm journey routing completed");
        } catch (err) { logger.error({ err, clientId: client.id }, "HP Warm client sweep failed; saved cursor will retry"); }
      }
    } catch (err) { logger.error({ err }, "HP Warm journey routing failed; next tick will retry"); }
    finally { busy = false; }
  };
  void tick();
  setInterval(() => void tick(), 60_000).unref();
}
