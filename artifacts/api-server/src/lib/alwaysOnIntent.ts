import { pool } from "@workspace/db";
import { isFreshPublicResearchEvidence } from "./researchFreshness";
import { isResearchGeographyEligible } from "./researchGeography";
import { createIntentRecommendation } from "./intent-recommendations";
import { UPLOADED_ANSWER_SIGNAL_TYPES } from "./intentImportAnswers";
import { analyzeProductFitment, hasExplicitNearTermBuyingContext } from "./signalProductFit";
import { researchSourceText } from "./researchSourceFacts";
import { PRODUCT_INTENT_ACTIVITY_SQL } from "./productIntentActivityQuery";
import type { PoolClient } from "pg";

export const ACCOUNT_TO_CONTACT_ATTENUATION = 0.35;

type Tier = { key: string; label: string; min_score: number };
export type IntentContribution = {
  key: string; label: string; points: number; reason: string; signalCount: number;
  rawStrength: number; decayFactor: number; evidence: unknown[];
};

const defaults = [
  ["target_account", "Target account", "account", 24, 30],
  ["kaboom_baseline", "Kaboom baseline", "baseline", 20, 30],
  ["firmographic", "Firmographic fit", "fit", 16, 90],
  ["event_feedback", "Event feedback", "event", 25, 21],
  ["event_questionnaire", "Event questionnaire", "event", 28, 45],
  ["lead_form", "Lead form", "form", 22, 30],
  ["consulting", "Consulting insight", "consulting", 20, 60],
  ["existing_behavior", "Existing behavior", "baseline", 15, 30],
  ["funding", "Funding", "public_event", 22, 90],
  ["layoffs", "Layoffs", "public_event", 14, 60],
  ["hiring", "Hiring", "public_event", 16, 45],
  ["procurement", "Tender / procurement", "public_event", 30, 30],
  ["branch_opening", "Branch opening", "public_event", 16, 90],
  ["merger_acquisition", "M&A", "public_event", 24, 180],
  ["cxo_appointment", "CXO appointment", "public_event", 16, 90],
  ["partnership", "Partnership", "public_event", 18, 90],
  ["quarterly_financial", "Quarterly financial", "public_event", 18, 90],
  ["technology_integration", "Technology integration", "public_event", 20, 90],
  ["capital_investment", "Capital investment", "public_event", 20, 120],
  ["regulatory_action", "Regulatory action", "public_event", 18, 90],
  ["operational_risk", "Operational risk", "public_event", 20, 90],
  ...UPLOADED_ANSWER_SIGNAL_TYPES,
] as const;

/** Public-event vocabulary shared by provider adapters and the HTTP boundary. */
export const PUBLIC_EVENT_TYPES = ["funding", "layoffs", "hiring", "procurement", "branch_opening", "merger_acquisition", "cxo_appointment", "partnership", "quarterly_financial", "technology_integration", "capital_investment", "regulatory_action", "operational_risk"] as const;
export type PublicEventType = typeof PUBLIC_EVENT_TYPES[number];

/** Stable dedup key: identical sources consolidate, while distinct coverage survives. */
export function eventFingerprint(event: { eventType: string; accountId: number; occurredAt: string; context?: unknown }) {
  const day = new Date(event.occurredAt).toISOString().slice(0, 10);
  // sourceIdentity is canonicalized before this function. It prevents every
  // same-day event of one type from collapsing into a single evidence row.
  const material = `${event.eventType}|${event.accountId}|${day}|${JSON.stringify(materialContext(event.context))}`;
  let hash = 2166136261;
  for (let i = 0; i < material.length; i++) hash = Math.imul(hash ^ material.charCodeAt(i), 16777619);
  return `${event.eventType}:${(hash >>> 0).toString(16)}`;
}
function materialContext(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(materialContext);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => ["location", "function", "executive", "amount", "counterparty", "sourceIdentity"].includes(key))
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, materialContext(item)]));
  return value ?? null;
}

export async function ensureIntentDefaults(tenantId: number): Promise<void> {
  for (const [key, label, category, maxPoints, halfLifeDays] of defaults) {
    await pool.query(
      `INSERT INTO intent_signal_types (tenant_id,key,label,category,max_points,half_life_days)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,key) DO NOTHING`,
      [tenantId, key, label, category, maxPoints, halfLifeDays],
    );
  }
  for (const [key, label, minScore, color, sortOrder] of [
    ["cold", "Cold", 0, "slate", 0], ["warm", "Warm", 35, "amber", 1], ["hot", "Hot", 70, "red", 2],
  ] as const) {
    await pool.query(
      `INSERT INTO intent_tiers (tenant_id,key,label,min_score,color,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,key) DO NOTHING`,
      [tenantId, key, label, minScore, color, sortOrder],
    );
  }
}

export function normalizedEmail(value: unknown): string | null {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
export function normalizedPhone(value: unknown): string | null {
  const phone = typeof value === "string" ? value.replace(/\D/g, "") : "";
  return phone.length >= 7 ? phone : null;
}
export function normalizedDomain(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const domain = raw.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? domain : null;
}

export async function matchEntities(tenantId: number, row: Record<string, unknown>) {
  const email = normalizedEmail(row.email);
  const phone = normalizedPhone(row.phone);
  const domain = normalizedDomain(row.domain ?? row.website);
  const companyName = typeof row.companyName === "string" ? row.companyName.trim().toLowerCase() : "";
  let contact: { id: number; company_id: number | null } | null = null;
  if (email) {
    const result = await pool.query<{ id: number; company_id: number | null }>(
      "SELECT id, company_id FROM contacts WHERE tenant_id=$1 AND lower(btrim(email))=$2 LIMIT 2", [tenantId, email],
    );
    contact = result.rows.length === 1 ? result.rows[0] : null;
  } else if (phone) {
    const result = await pool.query<{ id: number; company_id: number | null }>(
      "SELECT id, company_id FROM contacts WHERE tenant_id=$1 AND regexp_replace(coalesce(phone,''),'\\D','','g')=$2 LIMIT 2",
      [tenantId, phone],
    );
    contact = result.rows.length === 1 ? result.rows[0] : null;
  }
  const companyResult = domain
    ? await pool.query<{ id: number }>("SELECT id FROM companies WHERE tenant_id=$1 AND lower(btrim(domain))=$2 LIMIT 2", [tenantId, domain])
    : companyName
      ? await pool.query<{ id: number }>("SELECT id FROM companies WHERE tenant_id=$1 AND lower(btrim(name))=$2 LIMIT 2", [tenantId, companyName])
      : { rows: [] as { id: number }[] };
  const matchedCompany = companyResult.rows.length === 1 ? companyResult.rows[0].id : null;
  const conflict = Boolean(contact?.company_id && matchedCompany && contact.company_id !== matchedCompany);
  return {
    contactId: contact?.id ?? null,
    accountId: contact?.company_id ?? matchedCompany,
    email, phone, domain, conflict, matchedCompanyId: matchedCompany,
  };
}

export function base2Decay(ageDays: number, halfLifeDays: number): number {
  return Math.pow(2, -Math.max(0, ageDays) / Math.max(0.001, halfLifeDays));
}
export const QUESTIONNAIRE_PRODUCT_MONTHLY_RETENTION = 0.85;
export const QUESTIONNAIRE_PRODUCT_HALF_LIFE_DAYS = 30 * Math.log(2) / -Math.log(QUESTIONNAIRE_PRODUCT_MONTHLY_RETENTION);
export function signalDecay(signalKey: string, ageDays: number, halfLifeDays: number): number {
  if (signalKey === "questionnaire_product_interest") {
    return Math.pow(QUESTIONNAIRE_PRODUCT_MONTHLY_RETENTION, Math.max(0, ageDays) / 30);
  }
  return base2Decay(ageDays, halfLifeDays);
}
export function questionnaireSignalAudit(
  signal: { key: string; maxPoints: number; strength: number; occurredAt: Date | string; halfLifeDays: number; payload?: unknown },
  now: Date | string = new Date(),
) {
  const occurredAt = new Date(signal.occurredAt);
  const ageDays = Math.max(0, (new Date(now).getTime() - occurredAt.getTime()) / 86_400_000);
  const originalPoints = scoredSignalPoints(signal.maxPoints, signal.strength, signal.payload);
  const decayFactor = signalDecay(signal.key, ageDays, signal.halfLifeDays);
  const nextBoundary = Math.floor(ageDays / 30) + 1;
  return {
    ageDays: Math.floor(ageDays),
    originalPoints: Number(originalPoints.toFixed(2)),
    currentPoints: Number((originalPoints * decayFactor).toFixed(2)),
    decayFactor: Number(decayFactor.toFixed(4)),
    nextDecayAt: signal.key === "questionnaire_product_interest"
      ? new Date(occurredAt.getTime() + nextBoundary * 30 * 86_400_000).toISOString()
      : null,
    decayRule: signal.key === "questionnaire_product_interest"
      ? "Retains 85% of its remaining value every 30 days"
      : `Configured ${signal.halfLifeDays}-day half-life`,
  };
}
export function saturateRepeatedSignals(points: number[]): number {
  if (!points.length) return 0;
  const strongest = Math.max(...points);
  const remainder = points.reduce((sum, point) => sum + point, 0) - strongest;
  if (remainder <= 0) return strongest;
  return strongest + remainder * (1 - Math.exp(-(points.length - 1) / 2));
}

export function questionnaireAgingSummary(
  groups: Array<{ currentValues: number[]; originalValues: number[] }>,
): { currentPoints: number; originalPoints: number; retainedPercent: number } | undefined {
  const currentPoints = groups.reduce((total, group) => total + saturateRepeatedSignals(group.currentValues), 0);
  const originalPoints = groups.reduce((total, group) => total + saturateRepeatedSignals(group.originalValues), 0);
  if (originalPoints <= 0) return undefined;
  return {
    currentPoints: Number(currentPoints.toFixed(2)),
    originalPoints: Number(originalPoints.toFixed(2)),
    retainedPercent: Math.round((currentPoints / originalPoints) * 100),
  };
}

export function scoredSignalPoints(maxPoints: number, strength: number, payload: unknown): number {
  const fitmentPoints = payload && typeof payload === "object" ? Number((payload as Record<string, unknown>).fitmentPoints) : NaN;
  return Number.isFinite(fitmentPoints)
    ? Math.max(0, Math.min(100, fitmentPoints))
    : maxPoints * strength / 100;
}
export function selectIntentTier(score: number, tiers: Tier[]): Tier {
  const selected = [...tiers]
    .sort((a, b) => b.min_score - a.min_score)
    .find((tier) => score >= tier.min_score);
  return selected ?? { key: "cold", label: "Cold", min_score: 0 };
}

export function isPurchaseStageSignal(signal: { key:string; summary?:string|null; strength:number; payload?:unknown }) {
  const payload=signal.payload&&typeof signal.payload==="object"?signal.payload as Record<string,unknown>:{};
  if(signal.key==="questionnaire_timeframe"&&signal.strength>=90)return true;
  if(String(payload.fitmentLevel??"")!=="direct_intent"
    && !/\b(rfp|rfq|tender|procurement|pricing request|request(?:ed)? (?:a )?(?:quote|demo)|vendor evaluation|contract expiry|renewal|purchase order)\b/i.test(`${signal.key} ${signal.summary??""}`))return false;
  return hasExplicitNearTermBuyingContext(`${signal.key} ${signal.summary??""}`);
}

export function purchaseGateScore(rawScore:number,tiers:Tier[],hasRecentPurchaseSignal:boolean){
  const hotMin=tiers.find(tier=>tier.key==="hot")?.min_score??80;
  const score=hasRecentPurchaseSignal?Math.max(rawScore,Math.min(100,hotMin)):Math.min(rawScore,Math.max(0,hotMin-1));
  const selected=selectIntentTier(score,tiers);
  if(selected.key!=="hot"||hasRecentPurchaseSignal)return {score,tier:selected.key};
  const fallback=[...tiers].filter(tier=>tier.key!=="hot"&&tier.min_score<=score).sort((a,b)=>b.min_score-a.min_score)[0];
  return {score,tier:fallback?.key??"cold"};
}

type ProductScoreSignal = {
  key:string; label:string; max_points:number; half_life_days:number; strength:number; occurred_at:Date;
  account_id:number|null; contact_id:number|null; source:string; summary:string|null; payload:unknown;
  evidence_id:number|null; evidence_context:unknown; product_id:number; product_name:string;
  evidence_excerpt?:string|null; raw_evidence?:unknown;
  category_name:string; subcategory_name:string|null;
};

function productScoreFromSignals(signals:ProductScoreSignal[],tiers:Tier[],contactId:number|null=null){
  const grouped = new Map<string, { label:string; values:number[]; strengths:number[]; decays:number[]; evidence:unknown[] }>();
  let hasRecentPurchaseSignal=false;
  for (const signal of signals) {
    let scoringPayload=signal.payload;
    let sourceSummary=signal.summary;
    if (signal.source === "public_event") {
      if (!isResearchGeographyEligible({
        excerpt: signal.evidence_excerpt ?? (signal.evidence_id ? signal.summary : null), raw_evidence: signal.raw_evidence,
        context: signal.evidence_context as Record<string, unknown> | null,
      })) continue;
      sourceSummary=researchSourceText(signal.summary,signal.evidence_context as Record<string,unknown>);
      if (!isFreshPublicResearchEvidence(signal.summary, signal.occurred_at)) continue;
      const derivedFit = analyzeProductFitment(
        { eventType: signal.key, text: sourceSummary, confidence: signal.strength },
        { id: signal.product_id, name: signal.product_name, category: signal.category_name, subcategory: signal.subcategory_name },
      );
      if (!derivedFit || !["direct_intent", "confirmed_need"].includes(derivedFit.level)) continue;
      const payload = signal.payload && typeof signal.payload === "object" ? signal.payload as Record<string, unknown> : {};
      scoringPayload={...payload,fitmentLevel:derivedFit.level,fitmentPoints:derivedFit.points};
    }
    const decay = signalDecay(signal.key, (Date.now() - new Date(signal.occurred_at).getTime()) / 86_400_000, signal.half_life_days);
    const attenuation = contactId && signal.account_id && !signal.contact_id ? ACCOUNT_TO_CONTACT_ATTENUATION : 1;
    const group = grouped.get(signal.key) ?? { label: signal.label, values: [], strengths: [], decays: [], evidence: [] };
    group.values.push(scoredSignalPoints(signal.max_points, signal.strength, scoringPayload) * decay * attenuation);
    group.strengths.push(signal.strength); group.decays.push(decay);
    group.evidence.push({ signalPayload: scoringPayload, evidenceId: signal.evidence_id, evidenceContext: signal.evidence_context });
    grouped.set(signal.key, group);
    if(isPurchaseStageSignal({...signal,summary:sourceSummary,payload:scoringPayload}))hasRecentPurchaseSignal=true;
  }
  const contributions: IntentContribution[] = [...grouped].map(([key, group]) => ({ key, label:group.label, points:Number(saturateRepeatedSignals(group.values).toFixed(2)), reason:"Strength-weighted, base-2 decayed, frequency-saturated product signals", signalCount:group.values.length, rawStrength:Math.max(...group.strengths), decayFactor:Number(Math.min(...group.decays).toFixed(4)), evidence:group.evidence }));
  if (contributions.length > 1) contributions.push({ key:"breadth_bonus",label:"Signal breadth bonus",points:Math.min(10,(contributions.length-1)*2),reason:"Multiple independent signal categories",signalCount:contributions.length-1,rawStrength:0,decayFactor:1,evidence:[] });
  contributions.sort((a,b)=>b.points-a.points||a.key.localeCompare(b.key));
  const rawScore=Math.min(100,Math.round(contributions.reduce((sum,item)=>sum+item.points,0)));
  const gated=purchaseGateScore(rawScore,tiers,hasRecentPurchaseSignal);
  const contributingSignals = signals.filter(signal => signal.source !== "public_event" || (isFreshPublicResearchEvidence(signal.summary, signal.occurred_at) && isResearchGeographyEligible({
    excerpt: signal.evidence_excerpt ?? (signal.evidence_id ? signal.summary : null), raw_evidence: signal.raw_evidence,
    context: signal.evidence_context as Record<string, unknown> | null,
  })));
  return { score:gated.score, tier:gated.tier, scoreMeaning:"Category propensity", hasRecentPurchaseSignal, contributions, lastSignalAt: contributingSignals.reduce<Date|null>((latest,s)=>!latest||new Date(s.occurred_at)>latest?new Date(s.occurred_at):latest,null) };
}

/**
 * Product views are intentionally ephemeral: they use the same decayed,
 * saturated signal calculation but never write intent_entity_scores, history,
 * recommendations, or any legacy CRM record.
 */
export async function readProductIntentScore(
  tenantId: number,
  productId: number | number[],
  entity: { accountId?: number | null; contactId?: number | null },
) {
  const contactId = entity.contactId ?? null;
  const accountId = contactId ? null : entity.accountId ?? null;
  if (!contactId && !accountId) throw new Error("Product intent score requires an entity");
  const companyId = contactId
    ? (await pool.query<{ company_id: number | null }>("SELECT company_id FROM contacts WHERE tenant_id=$1 AND id=$2", [tenantId, contactId])).rows[0]?.company_id ?? null
    : accountId;
  const signals = await pool.query<ProductScoreSignal>(
    `SELECT st.key,st.label,COALESCE(qs.max_points,st.max_points) AS max_points,st.half_life_days,s.strength,s.occurred_at,s.account_id,s.contact_id,s.source,s.summary,s.payload,
       s.product_id,p.name AS product_name,pc.name AS category_name,psc.name AS subcategory_name,
       evidence.id AS evidence_id,evidence.context AS evidence_context,evidence.excerpt AS evidence_excerpt,evidence.raw_evidence
     FROM intent_signals s JOIN intent_signal_types st ON st.id=s.signal_type_id AND st.tenant_id=s.tenant_id
       JOIN intent_products p ON p.tenant_id=s.tenant_id AND p.id=s.product_id
       JOIN intent_product_categories pc ON pc.tenant_id=p.tenant_id AND pc.id=p.category_id
       LEFT JOIN intent_product_subcategories psc ON psc.tenant_id=p.tenant_id AND psc.id=p.subcategory_id
      LEFT JOIN intent_questionnaire_settings qs ON qs.tenant_id=s.tenant_id
        AND st.key='questionnaire_' || qs.dimension
      LEFT JOIN LATERAL (
        SELECT id,context,excerpt,raw_evidence FROM intent_evidence
        WHERE tenant_id=s.tenant_id AND (signal_id=s.id OR id=CASE WHEN s.payload->>'evidenceId' ~ '^[0-9]{1,9}$' THEN (s.payload->>'evidenceId')::int END) AND review_status='approved'
        ORDER BY id DESC LIMIT 1
      ) evidence ON true
      WHERE s.tenant_id=$1 AND s.product_id=ANY($2::int[]) AND st.active
        AND s.occurred_at>=NOW()-interval '1 year' AND (s.expires_at IS NULL OR s.expires_at>NOW())
        AND (NOT EXISTS(SELECT 1 FROM intent_evidence ie WHERE ie.tenant_id=s.tenant_id AND ie.signal_id=s.id)
          OR EXISTS(SELECT 1 FROM intent_evidence ie WHERE ie.tenant_id=s.tenant_id AND ie.signal_id=s.id AND ie.review_status='approved'))
       AND (s.contact_id=$3 OR s.account_id=$4)`,
    [tenantId, Array.isArray(productId) ? productId : [productId], contactId, companyId],
  );
  const tiers=(await pool.query<Tier>("SELECT key,label,min_score FROM intent_tiers WHERE tenant_id=$1 AND active",[tenantId])).rows;
  return productScoreFromSignals(signals.rows,tiers,contactId);
}

/** Lists use canonical qualification, not legacy product scores. Read only
 * the source facts needed for their activity date, never duplicate whole
 * opportunity briefs and provider payloads once per signal. */
export async function readProductIntentActivity(tenantId:number,productIds:number[],accountIds:number[]){
  const result=new Map<number,Date|null>();
  if(!accountIds.length||!productIds.length)return result;
  const {rows}=await pool.query<ProductScoreSignal & {has_activity_evidence:boolean}>(PRODUCT_INTENT_ACTIVITY_SQL,
    [tenantId,productIds,accountIds]);
  const geographyByEvidence=new Map<number,boolean>();
  // Source-only rows transfer each source once, even when many product
  // signals reference it. Hydrate before iterating: SQL row order is immaterial.
  const evidenceById=new Map<number,typeof rows[number]>();
  for(const row of rows)if(row.has_activity_evidence)evidenceById.set(row.evidence_id??0,row);
  for(const signal of rows){
    if(!signal.account_id)continue;
    if(signal.source==="public_event"){
      if(!isFreshPublicResearchEvidence(signal.summary,signal.occurred_at))continue;
      // A missing excerpt can fall back to this signal's summary, so only
      // reuse geography when the evidence itself supplies that excerpt.
      const evidence=evidenceById.get(signal.evidence_id??0)??signal;
      const cacheable=signal.evidence_id!=null&&evidence.evidence_excerpt!=null;
      let eligible=cacheable?geographyByEvidence.get(signal.evidence_id!):undefined;
      if(eligible===undefined){
        eligible=isResearchGeographyEligible({excerpt:evidence.evidence_excerpt??(signal.evidence_id?signal.summary:null),
          raw_evidence:evidence.raw_evidence,context:evidence.evidence_context as Record<string,unknown>|null});
        if(cacheable)geographyByEvidence.set(signal.evidence_id!,eligible);
      }
      if(!eligible)continue;
    }
    const latest=result.get(signal.account_id);
    if(!latest||new Date(signal.occurred_at)>latest)result.set(signal.account_id,new Date(signal.occurred_at));
  }
  return result;
}

export async function readProductIntentScores(tenantId:number,productIds:number[],accountIds:number[]){
  const output=new Map<number,ReturnType<typeof productScoreFromSignals>>();
  if(!accountIds.length)return output;
  const [signals,tiers]=await Promise.all([
    pool.query<ProductScoreSignal>(
      `SELECT st.key,st.label,COALESCE(qs.max_points,st.max_points) AS max_points,st.half_life_days,s.strength,s.occurred_at,s.account_id,s.contact_id,s.source,s.summary,s.payload,
         s.product_id,p.name AS product_name,pc.name AS category_name,psc.name AS subcategory_name,
         evidence.id AS evidence_id,evidence.context AS evidence_context,evidence.excerpt AS evidence_excerpt,evidence.raw_evidence
       FROM intent_signals s JOIN intent_signal_types st ON st.id=s.signal_type_id AND st.tenant_id=s.tenant_id
         JOIN intent_products p ON p.tenant_id=s.tenant_id AND p.id=s.product_id
         JOIN intent_product_categories pc ON pc.tenant_id=p.tenant_id AND pc.id=p.category_id
         LEFT JOIN intent_product_subcategories psc ON psc.tenant_id=p.tenant_id AND psc.id=p.subcategory_id
         LEFT JOIN intent_questionnaire_settings qs ON qs.tenant_id=s.tenant_id AND st.key='questionnaire_' || qs.dimension
         LEFT JOIN LATERAL (SELECT id,context,excerpt,raw_evidence FROM intent_evidence WHERE tenant_id=s.tenant_id AND (signal_id=s.id OR id=CASE WHEN s.payload->>'evidenceId' ~ '^[0-9]{1,9}$' THEN (s.payload->>'evidenceId')::int END) AND review_status='approved' ORDER BY id DESC LIMIT 1) evidence ON true
       WHERE s.tenant_id=$1 AND s.product_id=ANY($2::int[]) AND s.account_id=ANY($3::int[]) AND st.active
         AND s.occurred_at>=NOW()-interval '1 year' AND (s.expires_at IS NULL OR s.expires_at>NOW())
         AND (NOT EXISTS(SELECT 1 FROM intent_evidence ie WHERE ie.tenant_id=s.tenant_id AND ie.signal_id=s.id)
           OR EXISTS(SELECT 1 FROM intent_evidence ie WHERE ie.tenant_id=s.tenant_id AND ie.signal_id=s.id AND ie.review_status='approved'))`,
      [tenantId,productIds,accountIds],
    ),
    pool.query<Tier>("SELECT key,label,min_score FROM intent_tiers WHERE tenant_id=$1 AND active",[tenantId]),
  ]);
  const byAccount=new Map<number,ProductScoreSignal[]>();
  for(const signal of signals.rows){
    if(!signal.account_id)continue;
    const rows=byAccount.get(signal.account_id)??[];
    rows.push(signal); byAccount.set(signal.account_id,rows);
  }
  for(const accountId of accountIds)output.set(accountId,productScoreFromSignals(byAccount.get(accountId)??[],tiers.rows));
  return output;
}

export async function enqueueIntent(tenantId: number, entity: { accountId?: number | null; contactId?: number | null }, source: string) {
  const accountId = entity.contactId ? null : entity.accountId ?? null;
  const contactId = entity.contactId ?? null;
  if (!accountId && !contactId) return;
  if (contactId) {
    await pool.query(
      `INSERT INTO intent_recompute_queue(tenant_id,account_id,contact_id,source)
       VALUES($1,NULL,$2,$3)
       ON CONFLICT (tenant_id,contact_id) WHERE contact_id IS NOT NULL AND status IN ('pending','claimed') DO NOTHING`,
      [tenantId, contactId, source],
    );
  } else {
    await pool.query(
      `INSERT INTO intent_recompute_queue(tenant_id,account_id,contact_id,source)
       VALUES($1,$2,NULL,$3)
       ON CONFLICT (tenant_id,account_id) WHERE account_id IS NOT NULL AND status IN ('pending','claimed') DO NOTHING`,
      [tenantId, accountId, source],
    );
  }
}

function material(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(material);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !["at", "occurredAt", "createdAt", "updatedAt", "timestamp"].includes(key))
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, material(item)]));
  return value;
}
function fingerprint(tier: string, contributions: IntentContribution[]): string {
  return JSON.stringify({
    tier,
    contributions: contributions.map((item) => ({
      key: item.key,
      points: Math.round(item.points),
      signalCount: item.signalCount,
      evidence: material(item.evidence),
    })),
  });
}

async function legacyContribution(
  tenantId: number,
  contactId: number | null,
  accountId: number | null,
  executor: Pick<PoolClient, "query">,
): Promise<IntentContribution | null> {
  if (contactId) {
    const result = await executor.query<{ intent_score: number; website: number; email: number; call: number; tags: string[] }>(
      `SELECT c.intent_score,
       count(*) FILTER (WHERE a.event_type IN ('page_view','scroll_depth','form_submit','asset_download')
         OR a.event_type LIKE 'video_%')::int AS website,
       count(*) FILTER (WHERE a.event_type ILIKE '%email%')::int AS email,
       count(*) FILTER (WHERE a.event_type ILIKE '%call%')::int AS call, c.tags
       FROM contacts c LEFT JOIN activity_events a ON a.contact_id=c.id
         AND a.created_at > NOW()-interval '30 days'
         AND coalesce(a.is_bot,false)=false
       WHERE c.tenant_id=$1 AND c.id=$2 GROUP BY c.id`, [tenantId, contactId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const count = row.website + row.email + row.call;
    return { key: "existing_behavior", label: "Existing behavior", points: Math.min(15, row.intent_score * .2 + Math.min(5, count)),
      reason: "Read-only current contact score and recent non-bot activity", signalCount: count, rawStrength: row.intent_score,
      decayFactor: 1, evidence: [{ website: row.website, email: row.email, call: row.call, tags: row.tags ?? [] }] };
  }
  const result = await executor.query<{ score: number; contacts: number; activity_count: number }>(
    `SELECT COALESCE(sum(ranked.intent_score),0)::int AS score, count(DISTINCT ranked.id)::int AS contacts,
       count(a.id)::int AS activity_count
     FROM (
        SELECT c.id,c.intent_score FROM contacts c
        WHERE c.tenant_id=$1 AND c.company_id=$2 AND c.is_anonymous=false
        ORDER BY c.intent_score DESC,c.id LIMIT 5
     ) ranked
      LEFT JOIN activity_events a ON a.contact_id=ranked.id
        AND a.created_at > NOW()-interval '30 days'
        AND coalesce(a.is_bot,false)=false`,
    [tenantId, accountId],
  );
  return { key: "existing_behavior", label: "Existing behavior", points: Math.min(15, (result.rows[0]?.score ?? 0) * .06 + Math.min(5, (result.rows[0]?.activity_count ?? 0) * .25)),
     reason: "Read-only aggregate of top canonical contact scores and recent activity", signalCount: result.rows[0]?.contacts ?? 0,
    rawStrength: result.rows[0]?.score ?? 0, decayFactor: 1,
    evidence: [{ canonicalContacts: result.rows[0]?.contacts ?? 0, recentActivity: result.rows[0]?.activity_count ?? 0 }] };
}

export async function recomputeIntent(tenantId: number, entity: { accountId?: number | null; contactId?: number | null }, source = "recompute") {
  await ensureIntentDefaults(tenantId);
  const contactId = entity.contactId ?? null;
  const accountId = contactId ? null : entity.accountId ?? null;
  if (!contactId && !accountId) throw new Error("Intent recompute requires an entity");
  const client = await pool.connect();
  const lockKey = `intent-recompute:${tenantId}:${contactId ? `contact:${contactId}` : `account:${accountId}`}`;
  try {
  await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [lockKey]);
  const companyId = contactId
    ? (await client.query<{ company_id: number | null }>("SELECT company_id FROM contacts WHERE tenant_id=$1 AND id=$2", [tenantId, contactId])).rows[0]?.company_id ?? null
    : accountId;
  const signals = await client.query<{ key: string; label: string; max_points: number; half_life_days: number; strength: number; occurred_at: Date; account_id: number | null; contact_id: number | null; payload: unknown }>(
    `SELECT st.key,st.label,st.max_points,st.half_life_days,s.strength,s.occurred_at,s.account_id,s.contact_id,s.payload
     FROM intent_signals s JOIN intent_signal_types st ON st.id=s.signal_type_id AND st.tenant_id=s.tenant_id
     LEFT JOIN companies co ON co.id=$3 AND co.tenant_id=$1
     WHERE s.tenant_id=$1 AND s.product_id IS NULL AND st.active AND (s.expires_at IS NULL OR s.expires_at>NOW())
        AND (
          s.contact_id=$2
          OR s.account_id=$3
          OR (
            st.category='consulting'
            AND s.account_id IS NULL
            AND s.contact_id IS NULL
            AND s.vertical IS NOT NULL
            AND lower(btrim(s.vertical))=lower(btrim(co.industry))
          )
        )
       AND (st.category <> 'consulting' OR s.vertical IS NULL OR lower(btrim(s.vertical))=lower(btrim(co.industry)))
       AND (st.category <> 'consulting' OR s.client_id IS NULL OR s.client_id=co.client_id)`,
    [tenantId, contactId, companyId],
  );
  const grouped = new Map<string, { label: string; values: number[]; strengths: number[]; decays: number[]; evidence: unknown[] }>();
  for (const signal of signals.rows) {
    const decay = signalDecay(signal.key, (Date.now() - new Date(signal.occurred_at).getTime()) / 86_400_000, signal.half_life_days);
    const attenuation = contactId && signal.account_id && !signal.contact_id ? ACCOUNT_TO_CONTACT_ATTENUATION : 1;
    const group = grouped.get(signal.key) ?? { label: signal.label, values: [], strengths: [], decays: [], evidence: [] };
    group.values.push(signal.max_points * (signal.strength / 100) * decay * attenuation);
    group.strengths.push(signal.strength); group.decays.push(decay); group.evidence.push(signal.payload); grouped.set(signal.key, group);
  }
  const contributions: IntentContribution[] = [...grouped].map(([key, group]) => ({
    key, label: group.label, points: Number(saturateRepeatedSignals(group.values).toFixed(2)),
    reason: "Strength-weighted, base-2 decayed, frequency-saturated signals", signalCount: group.values.length,
    rawStrength: Math.max(...group.strengths), decayFactor: Number(Math.min(...group.decays).toFixed(4)), evidence: group.evidence,
  }));
  const legacy = await legacyContribution(tenantId, contactId, accountId, client);
  if (legacy && legacy.points > 0) contributions.push(legacy);
  if (contributions.length > 1) contributions.push({ key: "breadth_bonus", label: "Signal breadth bonus", points: Math.min(10, (contributions.length - 1) * 2), reason: "Multiple independent signal categories", signalCount: contributions.length - 1, rawStrength: 0, decayFactor: 1, evidence: [] });
  contributions.sort((a, b) => b.points - a.points || a.key.localeCompare(b.key));
  const score = Math.min(100, Math.round(contributions.reduce((sum, item) => sum + item.points, 0)));
  const lastSignalAt = signals.rows.reduce<Date | null>((latest, signal) => {
    const occurredAt = new Date(signal.occurred_at);
    return !latest || occurredAt > latest ? occurredAt : latest;
  }, null);
  const tiers = (await client.query<Tier>("SELECT key,label,min_score FROM intent_tiers WHERE tenant_id=$1 AND active", [tenantId])).rows;
  const selectedTier = selectIntentTier(score, tiers);
  const old = await client.query<{ id: number; score: number; tier: string; contributions: IntentContribution[] }>(
    `SELECT id,score,tier,contributions FROM intent_entity_scores WHERE tenant_id=$1 AND ${contactId ? "contact_id" : "account_id"}=$2 LIMIT 1`,
    [tenantId, contactId ?? accountId],
  );
  const previousScore = old.rows[0]?.score ?? 0;
  const trendDelta = score - previousScore;
  const trend = trendDelta > 0 ? "up" : trendDelta < 0 ? "down" : "stable";
  const saved = await client.query<{ id: number }>(
    `INSERT INTO intent_entity_scores(tenant_id,account_id,contact_id,score,previous_score,tier,trend,trend_delta,last_signal_at,contributions,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
     ON CONFLICT (tenant_id,${contactId ? "contact_id" : "account_id"}) WHERE ${contactId ? "contact_id" : "account_id"} IS NOT NULL
     DO UPDATE SET score=EXCLUDED.score,previous_score=intent_entity_scores.score,tier=EXCLUDED.tier,trend=EXCLUDED.trend,trend_delta=EXCLUDED.trend_delta,last_signal_at=EXCLUDED.last_signal_at,contributions=EXCLUDED.contributions,updated_at=NOW() RETURNING id`,
    [tenantId, accountId, contactId, score, previousScore, selectedTier.key, trend, trendDelta, lastSignalAt, JSON.stringify(contributions)],
  );
  if (!old.rows[0] || old.rows[0].score !== score || old.rows[0].tier !== selectedTier.key || JSON.stringify(material(old.rows[0].contributions)) !== JSON.stringify(material(contributions))) {
    await client.query("INSERT INTO intent_score_history(tenant_id,entity_score_id,score,tier,contributions,source) VALUES($1,$2,$3,$4,$5,$6)", [tenantId, saved.rows[0].id, score, selectedTier.key, JSON.stringify(contributions), source]);
  }
  const details = contactId
    ? await client.query<{ email: string | null; phone: string | null; title: string | null; name: string | null }>(
      "SELECT c.email,c.phone,c.title,co.name FROM contacts c LEFT JOIN companies co ON co.id=c.company_id AND co.tenant_id=c.tenant_id WHERE c.tenant_id=$1 AND c.id=$2",
      [tenantId, contactId],
    )
    : await client.query<{ email: null; phone: null; title: null; name: string | null }>(
      "SELECT NULL::text AS email,NULL::text AS phone,NULL::text AS title,name FROM companies WHERE tenant_id=$1 AND id=$2",
      [tenantId, accountId],
    );
  await createIntentRecommendation({
    tenantId,
    accountId: contactId ? null : accountId,
    contactId,
    tier: selectedTier.key,
    fingerprint: fingerprint(selectedTier.key, contributions),
    contributions,
    contact: contactId ? details.rows[0] : null,
    company: details.rows[0] ? { name: details.rows[0].name } : null,
  }, client);
  return { score, tier: selectedTier.key, trend, trendDelta, contributions };
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockKey]).catch(() => undefined);
    client.release();
  }
}

export async function processIntentQueue(
  limit = 100,
  processor: typeof recomputeIntent = recomputeIntent,
) {
  await pool.query("UPDATE intent_recompute_queue SET status='pending',claimed_at=NULL,updated_at=NOW() WHERE status='claimed' AND claimed_at < NOW()-interval '15 minutes'");
  const claimed = await pool.query<{ id: number; tenant_id: number; account_id: number | null; contact_id: number | null; source: string; attempts: number; max_attempts: number; claimed_at: Date }>(
    `WITH claimable AS (
       SELECT id
       FROM intent_recompute_queue
       WHERE status='pending' AND available_at<=NOW()
       ORDER BY CASE WHEN source='nightly_decay' THEN 1 ELSE 0 END,available_at,id
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE intent_recompute_queue q SET status='claimed',claimed_at=NOW(),attempts=q.attempts+1,updated_at=NOW() FROM claimable WHERE q.id=claimable.id RETURNING q.*`, [limit],
  );
  for (const item of claimed.rows) {
    try {
      await processor(item.tenant_id, { accountId: item.account_id, contactId: item.contact_id }, item.source);
      await pool.query(
        "UPDATE intent_recompute_queue SET status='done',updated_at=NOW() WHERE id=$1 AND status='claimed' AND attempts=$2",
        [item.id, item.attempts],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "Unknown intent recompute error";
      const dead = item.attempts >= item.max_attempts;
      await pool.query(`UPDATE intent_recompute_queue SET status=$2,error=$3,claimed_at=NULL,available_at=NOW() + ($4 * interval '1 minute'),updated_at=NOW()
        WHERE id=$1 AND status='claimed' AND attempts=$5`,
        [item.id, dead ? "dead" : "pending", message, Math.min(60, 2 ** Math.max(0, item.attempts - 1)), item.attempts]);
    }
  }
  return claimed.rows.length;
}