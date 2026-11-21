import { monitoredAccountContext, hasCompleteMonitoredResearch } from "../lib/monitoredAccountContext";
import { Router, type IRouter, type Request } from "express";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { requireAuth } from "../middlewares/requireAuth";
import { inferProductsFromInterest } from "../lib/intentImportProductMatching";
import { evaluateTwoLevelIntentStatus } from "../lib/twoLevelIntentStatus";
import { isResearchGeographyEligible } from "../lib/researchGeography";
import { googleSpreadsheetId } from "../lib/googleSheetsIntent";
import { isFreshInboundHot } from "../lib/intentOpportunityFreshness";
import { inboundCategories, inboundCategoryForInterest, loadInboundCategoryRules } from "../lib/inboundTaxonomy";

const router: IRouter = Router();
router.use(requireAuth);
const connectors = new ReplitConnectors();
const positiveInt = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};
const userTenant = (req: Request) => Number((req.user as any)?.tenantId);
const nameOf = (row: any) => [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
const csv = (value: unknown) => {
  const text = String(value ?? "").replace(/[\r\n]+/g, " ");
  const safe = /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
};
const validDate = (value: unknown) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
};

type Product = { id: number; name: string; category_id: number; category_name: string; subcategory_name: string | null };
type Opportunity = {
  accountId: number; accountName: string; clientId: number; productId: number; productName: string;
  categoryId: number; categoryName: string; status: "hot" | "warm" | "review"; source: string;
  journeyName: string | null; sequenceName: string | null;
  reason: string; contact: { id: number; name: string; email: string | null } | null;
  score: { people: number; monitoring: number; total: number }; latestActionAt: string | null;
  nextStep: string; handoffStatus: string | null; evidenceLink: string | null;
};
type CandidateFilters = {
  clientId: number | null; productId: number | null; categoryId: number | null; categoryName?: string | null;
  accountId: number | null; search: string | null;
};
type OpportunityCategoryConfig = Awaited<ReturnType<typeof loadInboundCategoryRules>>;

const opportunityCategoryNames = [...inboundCategories, "Needs categorization"];

function requestedCategoryName(value: unknown): string | null | undefined {
  if (value == null) return null;
  if (typeof value !== "string" || !opportunityCategoryNames.includes(value.trim())) return undefined;
  return value.trim();
}

function hasSavedCategoryMatch(value: string, config: OpportunityCategoryConfig) {
  const normalized = value.toLocaleLowerCase().replace(/\s+/g, " ");
  return config.rules.some(rule => rule.terms.some(term => {
    const needle = term.toLocaleLowerCase().trim().replace(/\s+/g, " ");
    const index = normalized.indexOf(needle);
    return index >= 0 && (index === 0 || !/[\p{L}\p{N}]/u.test(normalized[index - 1]))
      && (index + needle.length === normalized.length || !/[\p{L}\p{N}]/u.test(normalized[index + needle.length]));
  }));
}

function categoryForOpportunity(
  value: string,
  productRow: Product,
  config: OpportunityCategoryConfig,
) {
  const category = inboundCategoryForInterest(value, null, config).categoryName;
  if (category !== "Needs categorization" || !config.useBuiltin || hasSavedCategoryMatch(value, config)) return category;
  // Preserve the catalog identity while exposing its closest supported category
  // in the four-category intent view. This is display categorization only.
  const legacyCategory = productRow.category_name.trim().toLocaleLowerCase();
  if (legacyCategory === "it hardware") return "IT Hardware";
  if (legacyCategory === "virtual collaboration") return "Business Collaboration";
  if (legacyCategory === "software & services" || legacyCategory === "services") return "Business Services";
  if (legacyCategory === "commercial printing") return "Business Services";
  if (legacyCategory === "security") return "Security";
  return "Needs categorization";
}

async function product(tenantId: number, productId: number): Promise<Product | null> {
  const result = await pool.query<Product>(`SELECT p.id,p.name,p.category_id,c.name AS category_name,
      s.name AS subcategory_name
    FROM intent_products p JOIN intent_product_categories c
      ON c.tenant_id=p.tenant_id AND c.id=p.category_id
    LEFT JOIN intent_product_subcategories s ON s.tenant_id=p.tenant_id AND s.id=p.subcategory_id
    WHERE p.tenant_id=$1 AND p.id=$2 AND p.active=true`, [tenantId, productId]);
  return result.rows[0] ?? null;
}

function inboundMatches(interest: string | null, productRow: Product, catalog: Product[]) {
  if (!interest?.trim()) return false;
  const matchCatalog = catalog.map(item => ({
    id: item.id, name: item.name, category: item.category_name, subcategory: item.subcategory_name,
  }));
  // An account-product opportunity needs product evidence, not a category word
  // inside a selected service name (e.g. "Services" matching all Services).
  return inferProductsFromInterest(interest, matchCatalog, { includeCategoryMatches: false })
    .some(matched => matched.id === productRow.id);
}

async function scopedCatalog(tenantId: number) {
  const result = await pool.query<Product>(`SELECT p.id,p.name,p.category_id,c.name AS category_name,
      s.name AS subcategory_name
    FROM intent_products p JOIN intent_product_categories c
      ON c.tenant_id=p.tenant_id AND c.id=p.category_id
    LEFT JOIN intent_product_subcategories s ON s.tenant_id=p.tenant_id AND s.id=p.subcategory_id
    WHERE p.tenant_id=$1 AND p.active=true`, [tenantId]);
  return result.rows;
}

function classifyEvidenceRows(
  rows: any[],
  productRow: Product,
  categoryConfig: OpportunityCategoryConfig,
  catalog: Product[] = [productRow],
) {
  const scoped = rows.filter((row: any) => {
    if (row.product_id != null) return Number(row.product_id) === productRow.id;
    const category = String(row.context?.category ?? row.context?.categoryName ?? "").toLowerCase();
    return category === productRow.category_name.toLowerCase() ||
      inboundMatches(row.excerpt ?? "", productRow, catalog);
  });
  if (!scoped.length) return {
    status: "review" as const, reason: "Evidence is not yet product-qualified.",
    rows: [], qualifyingEvidenceIds: [] as number[],
  };
  const resultStatus = evaluateTwoLevelIntentStatus(scoped.filter((row: any) =>
    row.review_status === "approved").map((row: any) => {
      const context = row.context && typeof row.context === "object" ? row.context : {};
      const categorySource = String(context.productInterest ?? context.product_interest ?? context.productName ??
        context.product_name ?? context.interest ?? row.excerpt ?? productRow.name);
      const categoryName = categoryForOpportunity(categorySource, productRow, categoryConfig);
      return {
    id: Number(row.id), evidenceKind: row.evidence_kind, eventType: row.event_type,
    excerpt: row.excerpt ?? "", sourceUrl: row.source_url, occurredAt: row.occurred_at,
    confidence: Number(row.confidence), reviewStatus: row.review_status,
    context: { ...context, inboundCategoryName: categoryName }, raw_evidence: row.raw_evidence,
  };
  }), undefined, categoryConfig);
  const representative = scoped.find((row: any) => row.product_id != null) ?? scoped[0];
  const representativeContext = representative.context && typeof representative.context === "object"
    ? representative.context : {};
  const representativeCategorySource = String(representativeContext.productInterest ??
    representativeContext.product_interest ?? representativeContext.productName ??
    representativeContext.product_name ?? representativeContext.interest ??
    representative.excerpt ?? productRow.name);
  const mappedCategoryName = categoryForOpportunity(representativeCategorySource, productRow, categoryConfig);
  const category = resultStatus.categories.find((item) => item.name.toLowerCase() === mappedCategoryName.toLowerCase());
  if (category && category.attribution !== "INHERITED_OPEN" &&
      (category.status === "hot" || category.status === "warm")) {
    const drivingIds = category.drivingSignals.map(signal => signal.evidenceId).filter(id => id > 0);
    const productProof = scoped.some((row: any) =>
      Number(row.product_id) === productRow.id && drivingIds.includes(Number(row.id)));
    return {
      status: category.status === "hot" && !productProof ? "warm" as const : category.status,
      reason: category.status === "hot" && !productProof
        ? "Category evidence indicates interest; confirm product-specific purchase proof before handoff."
        : category.statusReason,
      rows: scoped, qualifyingEvidenceIds: drivingIds,
    };
  }
  return {
    status: "review" as const, reason: category?.statusReason ?? "Evidence needs product/category review.",
    rows: scoped, qualifyingEvidenceIds: [] as number[],
  };
}

async function evidenceStatus(
  tenantId: number,
  accountId: number,
  productRow: Product,
  categoryConfig?: OpportunityCategoryConfig,
) {
  const result = await pool.query<any>(`SELECT e.id,e.product_id,e.evidence_kind,e.event_type,e.excerpt,
      e.source_url,e.occurred_at,e.confidence,e.review_status,e.context,e.raw_evidence
    FROM intent_evidence e
    JOIN companies c ON c.tenant_id=e.tenant_id AND c.id=e.account_id
    JOIN clients cl ON cl.tenant_id=c.tenant_id AND cl.id=c.client_id
    WHERE e.tenant_id=$1 AND e.account_id=$2
      AND (e.product_id=$3 OR e.product_id IS NULL)
      AND c.client_id IS NOT NULL AND e.review_status<>'rejected'
      AND e.evidence_kind NOT IN ('lead_form','event_feedback','event_questionnaire','product_buy_intent')
    ORDER BY e.occurred_at DESC,e.id DESC`, [tenantId, accountId, productRow.id]);
  return classifyEvidenceRows(result.rows, productRow, categoryConfig ?? await loadInboundCategoryRules(tenantId));
}

async function opportunityScores(
  tenantId: number,
  accountId: number,
  productId: number,
  categoryConfig?: OpportunityCategoryConfig,
) {
  // Scores are intentionally product-attributed and exclude anonymous contacts and
  // the global CRM lead_score / unscoped intent_entity_scores.
  const qualification = await product(tenantId, productId);
  const qualifiedEvidence = qualification
    ? await evidenceStatus(tenantId, accountId, qualification, categoryConfig)
    : { status: "review", reason: "", rows: [], qualifyingEvidenceIds: [] as number[] };
  const eligibleEvidenceIds = qualifiedEvidence.qualifyingEvidenceIds;
  const [signals, actions, monitored] = await Promise.all([
    pool.query<any>(`SELECT s.id,s.contact_id,trim(concat_ws(' ',ct.first_name,ct.last_name)) AS name,
        ct.email,ct.tags,st.key,st.max_points,s.strength,s.occurred_at,s.payload
      FROM intent_signals s
      JOIN intent_signal_types st ON st.id=s.signal_type_id AND st.tenant_id=s.tenant_id AND st.active=true
      JOIN contacts ct ON ct.tenant_id=s.tenant_id AND ct.id=s.contact_id
      JOIN companies c ON c.tenant_id=ct.tenant_id AND c.id=ct.company_id
      JOIN clients cl ON cl.tenant_id=c.tenant_id AND cl.id=c.client_id
      WHERE s.tenant_id=$1 AND s.account_id=$2 AND c.id=$2 AND s.product_id=$3
        AND ct.is_anonymous=false
        AND (NULLIF(btrim(ct.email),'') IS NOT NULL OR
          NULLIF(btrim(concat_ws(' ',ct.first_name,ct.last_name)),'') IS NOT NULL)
        AND c.client_id=ct.client_id AND (s.client_id IS NULL OR s.client_id=c.client_id)
        AND s.contact_id IS NOT NULL
        AND st.category='questionnaire'
        AND s.occurred_at >= NOW()-INTERVAL '3 months'
      ORDER BY s.occurred_at DESC,s.id DESC`, [tenantId, accountId, productId]),
    pool.query<any>(`SELECT ae.id,ae.contact_id,trim(concat_ws(' ',ct.first_name,ct.last_name)) AS name,
        ct.email,ct.tags,ae.event_type,ae.description,ae.points_earned,ae.created_at,ae.metadata
      FROM activity_events ae
      JOIN contacts ct ON ct.tenant_id=ae.tenant_id AND ct.id=ae.contact_id
      JOIN companies c ON c.tenant_id=ct.tenant_id AND c.id=ct.company_id
      JOIN clients cl ON cl.tenant_id=c.tenant_id AND cl.id=c.client_id
      WHERE ae.tenant_id=$1 AND c.id=$2 AND c.client_id=ct.client_id
        AND (ae.client_id IS NULL OR ae.client_id=c.client_id)
        AND ct.is_anonymous=false
        AND (NULLIF(btrim(ct.email),'') IS NOT NULL OR
          NULLIF(btrim(concat_ws(' ',ct.first_name,ct.last_name)),'') IS NOT NULL)
        AND COALESCE(ae.is_bot,false)=false
        AND ae.event_type IN ('page_view','email_open','email_click')
        AND ae.metadata::jsonb->>'productId'=$3::text
        AND ae.created_at >= NOW()-INTERVAL '3 months'
      ORDER BY ae.created_at DESC,ae.id DESC`, [tenantId, accountId, productId]),
    pool.query<any>(`SELECT DISTINCT ON (COALESCE(e.event_fingerprint,e.id::text))
        e.id,e.confidence,e.occurred_at,e.excerpt,e.source_url,e.event_type,
        e.context,e.provider,e.raw_evidence
      FROM intent_evidence e JOIN companies c ON c.tenant_id=e.tenant_id AND c.id=e.account_id
      JOIN clients cl ON cl.tenant_id=c.tenant_id AND cl.id=c.client_id
      WHERE e.tenant_id=$1 AND e.account_id=$2
        AND (e.product_id=$3 OR (e.product_id IS NULL AND
          lower(COALESCE(e.context->>'category',e.context->>'categoryName',''))=lower($5)))
        AND c.client_id IS NOT NULL AND e.review_status='approved'
        AND e.evidence_kind='public_event' AND e.id=ANY($4::int[])
      ORDER BY COALESCE(e.event_fingerprint,e.id::text),e.occurred_at DESC,e.id DESC`,
    [tenantId, accountId, productId, eligibleEvidenceIds, qualification?.category_name ?? ""]),
  ]);
  const byContact = new Map<number, any>();
  const seen = new Set<string>();
  const addPersonContribution = (row: any, kind: "signal" | "action") => {
    const id = Number(row.contact_id);
    const key = `${kind}:${row.id}`;
    if (!id || seen.has(key)) return;
    seen.add(key);
    const person = byContact.get(id) ?? {
      id, name: row.name || row.email, email: row.email, tags: row.tags ?? [], score: 0,
    };
    const points = kind === "signal"
      ? Number(row.max_points) * Number(row.strength) / 100
      : Math.max(0, Number(row.points_earned) || 0);
    person.score += points;
    byContact.set(id, person);
  };
  for (const row of signals.rows) addPersonContribution(row, "signal");
  for (const row of actions.rows) addPersonContribution(row, "action");
  let monitoring = 0;
  const monitoringIds = new Set<number>();
  for (const row of monitored.rows) {
    if (monitoringIds.has(Number(row.id)) || !isResearchGeographyEligible({
      excerpt: row.excerpt ?? "", confidence: Number(row.confidence),
      context: row.context ?? {}, sourceUrl: row.source_url ?? undefined,raw_evidence:row.raw_evidence,
    })) continue;
    monitoringIds.add(Number(row.id));
    monitoring += Number(row.confidence);
  }
  const people = [...byContact.values()].map(person => ({ ...person, score: Math.round(person.score) }));
  const peopleScore = people.reduce((total, person) => total + person.score, 0);
  return { people: peopleScore, monitoring, total: peopleScore + monitoring, contacts: people,
    monitoringContributions: monitored.rows.filter(row => monitoringIds.has(Number(row.id)))
      .map(row => ({ id: Number(row.id), points: Number(row.confidence) })) };
}

async function classifyCandidates(tenantId: number, filters: CandidateFilters, preview?: {
  count: number; status: "hot" | "warm" | "review" | null; skip?: number;
  scan?: { start: number; maxRows: number; nextOffset: number | null; batchSize?: number };
  recentEvidenceLimit?: number;
}, categoryConfigArg?: OpportunityCategoryConfig): Promise<Opportunity[]> {
  const catalog = await scopedCatalog(tenantId);
  const categoryConfig = categoryConfigArg ?? await loadInboundCategoryRules(tenantId);
  const evidenceSource = preview?.recentEvidenceLimit
    ? `FROM (SELECT * FROM intent_evidence
        WHERE tenant_id=$1 AND evidence_kind='public_event' AND review_status<>'rejected'
        ORDER BY occurred_at DESC,id DESC LIMIT ${preview.recentEvidenceLimit}) e`
    : "FROM intent_evidence e";
  const candidateSql = `WITH candidate_pairs AS (
    SELECT DISTINCT c.id AS account_id,c.name AS account_name,c.client_id,p.id AS product_id,
      p.name AS product_name,p.category_id,pc.name AS category_name,
      s.classification AS first_status,'inbound'::text AS source,
      s.classification_reason AS first_reason,s.contact_id,s.product_interest,s.form_type,
      COALESCE(s.submitted_at,s.created_at) AS latest_at
    FROM intent_inbound_submissions s
    JOIN companies c ON c.tenant_id=s.tenant_id AND c.id=s.account_id AND c.client_id=s.client_id
    JOIN clients cl ON cl.tenant_id=c.tenant_id AND cl.id=c.client_id
    JOIN intent_products p ON p.tenant_id=s.tenant_id AND p.active=true
    JOIN intent_product_categories pc ON pc.tenant_id=p.tenant_id AND pc.id=p.category_id
    LEFT JOIN intent_product_subcategories psc ON psc.tenant_id=p.tenant_id AND psc.id=p.subcategory_id
    WHERE s.tenant_id=$1 AND s.classification IN ('hot','warm')
      AND NULLIF(btrim(s.product_interest),'') IS NOT NULL
      AND (
        regexp_replace(lower(s.product_interest),'[^a-z0-9]+',' ','g') LIKE
          '%'||regexp_replace(lower(p.name),'[^a-z0-9]+',' ','g')||'%'
        OR (psc.name IS NOT NULL AND regexp_replace(lower(s.product_interest),'[^a-z0-9]+',' ','g') LIKE
          '%'||regexp_replace(lower(COALESCE(psc.name,'')),'[^a-z0-9]+',' ','g')||'%'
        )
        OR EXISTS (SELECT 1 FROM regexp_split_to_table(
          lower(regexp_replace(concat_ws(' ',p.name,psc.name),'[^a-z0-9]+',' ','g')),'\\s+') AS token
          WHERE length(token)>2 AND token NOT IN
            ('and','for','the','with','service','services','solution','solutions','product','products','about',
             'know','more','following','interested')
            AND lower(s.product_interest) LIKE '%'||token||'%')
        OR (s.product_interest ~* '\\b(laptop|notebook|employee pc|end.user comput|device.as.a.service|daas)\\b'
          AND concat_ws(' ',p.name,psc.name) ~* '\\b(laptop|workstation|end.user comput|device.as.a.service|daas)\\b')
        OR (s.product_interest ~* '\\b(device.as.a.service|daas)\\b'
          AND concat_ws(' ',p.name,psc.name) ~* '\\bmanaged device( and computing)? services?\\b')
        OR (s.product_interest ~* '\\b(headset|headphone|earbud|noise cancell|anc)\\b'
          AND concat_ws(' ',p.name,psc.name) ~* '\\b(headphone|headset|active noise cancellation|anc)\\b')
        OR (s.product_interest ~* '\\b(video conferenc|hybrid meeting|meeting room|video bar|webcam)\\b'
          AND concat_ws(' ',p.name,psc.name) ~* '\\bvideo conferencing\\b')
        OR (s.product_interest ~* '\\b(printer|printing|managed print|multifunction)\\b'
          AND concat_ws(' ',p.name,psc.name) ~* '\\blaser printer\\b')
        OR (s.product_interest ~* '\\b(audio conferenc|speakerphone|conference phone)\\b'
          AND concat_ws(' ',p.name,psc.name) ~* '\\baudio conferencing\\b')
        OR (s.product_interest ~* '\\b(teleconferenc|meeting bridge|conference service)\\b'
          AND concat_ws(' ',p.name,psc.name) ~* '\\bteleconferencing\\b')
        OR (s.product_interest ~* '\\b(monitor|display|digital signage)\\b'
          AND concat_ws(' ',p.name,psc.name) ~* '\\b(monitor|display)\\b')
        OR (s.product_interest ~* '\\b(server|storage|backup|nas)\\b'
          AND concat_ws(' ',p.name,psc.name) ~* '\\b(server|storage)\\b')
        OR (s.product_interest ~* '\\b(network|switch|router|wireless|wi-?fi)\\b'
          AND concat_ws(' ',p.name,psc.name) ~* '\\bnetwork\\b')
        OR (s.product_interest ~* '\\b(dock|keyboard|mouse|peripheral|accessor)\\b'
          AND concat_ws(' ',p.name,psc.name) ~* '\\b(peripheral|accessor)\\b')
      )
      AND ($2::int IS NULL OR c.client_id=$2)
      AND ($3::int IS NULL OR p.id=$3)
      AND ($4::int IS NULL OR p.category_id=$4)
      AND ($6::int IS NULL OR c.id=$6)
      AND ($5::text IS NULL OR c.name ILIKE '%'||$5||'%' OR p.name ILIKE '%'||$5||'%')
    UNION ALL
    SELECT DISTINCT c.id,c.name,c.client_id,p.id,p.name,p.category_id,pc.name,
      NULL::text,'monitoring'::text,NULL::text,NULL::int,NULL::text,NULL::text,e.occurred_at
    ${evidenceSource}
    JOIN companies c ON c.tenant_id=e.tenant_id AND c.id=e.account_id
    JOIN clients cl ON cl.tenant_id=c.tenant_id AND cl.id=c.client_id
    JOIN intent_products p ON p.tenant_id=e.tenant_id AND p.active=true
    JOIN intent_product_categories pc ON pc.tenant_id=p.tenant_id AND pc.id=p.category_id
    LEFT JOIN intent_product_subcategories psc ON psc.tenant_id=p.tenant_id AND psc.id=p.subcategory_id
    WHERE e.tenant_id=$1 AND e.evidence_kind='public_event' AND e.review_status<>'rejected'
       AND (e.product_id=p.id OR (e.product_id IS NULL AND (
         lower(COALESCE(e.context->>'category',e.context->>'categoryName',''))=lower(pc.name)
         OR (length(regexp_replace(lower(p.name),'[^a-z0-9]+','','g'))>3 AND
           regexp_replace(lower(concat_ws(' ',e.excerpt,e.context->>'productName',e.context->>'product_name',e.context->>'productInterest',e.context->>'product_interest')),'[^a-z0-9]+',' ','g') LIKE
             '%'||regexp_replace(lower(p.name),'[^a-z0-9]+',' ','g')||'%')
         OR (psc.name IS NOT NULL AND length(regexp_replace(lower(psc.name),'[^a-z0-9]+','','g'))>3 AND
           regexp_replace(lower(concat_ws(' ',e.excerpt,e.context->>'productName',e.context->>'product_name',e.context->>'productInterest',e.context->>'product_interest')),'[^a-z0-9]+',' ','g') LIKE
             '%'||regexp_replace(lower(psc.name),'[^a-z0-9]+',' ','g')||'%')
       )))
      AND ($2::int IS NULL OR c.client_id=$2)
      AND ($3::int IS NULL OR p.id=$3)
      AND ($4::int IS NULL OR p.category_id=$4)
      AND ($6::int IS NULL OR c.id=$6)
      AND ($5::text IS NULL OR c.name ILIKE '%'||$5||'%' OR p.name ILIKE '%'||$5||'%' OR e.excerpt ILIKE '%'||$5||'%')
  ), ranked AS (
    SELECT *,row_number() OVER(PARTITION BY account_id,product_id
      ORDER BY (first_status IS NOT NULL) DESC,latest_at DESC) AS pair_rank
    FROM candidate_pairs
  )
  SELECT * FROM ranked WHERE pair_rank=1
  ORDER BY ${preview?.recentEvidenceLimit && preview.status ? "(first_status IS NOT NULL) DESC," : ""}latest_at DESC,account_id,product_id
  LIMIT $7 OFFSET $8`;
  const fetchBatch = (offset: number, limit: number) =>
    pool.query<any>(candidateSql, [tenantId, filters.clientId, filters.productId, filters.categoryId,
      filters.search, filters.accountId, limit, offset]);
  const classified: Opportunity[] = [];
  const batchSize = preview?.scan?.batchSize ?? (preview?.scan ? 50 : preview ? 25 : 100);
  let rawOffset = preview?.scan?.start ?? 0;
  const scanEnd = preview?.scan ? preview.scan.start + preview.scan.maxRows : Infinity;
  let matched = 0;
  while (rawOffset < scanEnd) {
    const batch = await fetchBatch(rawOffset, Math.min(batchSize, scanEnd - rawOffset));
    if (!batch.rows.length) break;
    rawOffset += batch.rows.length;
    const accountIds = [...new Set<number>(batch.rows.map((row: any) => Number(row.account_id)))];
    const [submissionRows, evidenceRows] = await Promise.all([
      pool.query<any>(`SELECT s.id,s.account_id,s.product_interest,s.form_type,
          s.classification,s.classification_reason,COALESCE(s.submitted_at,s.created_at) AS action_at,
          ct.id AS contact_id,ct.first_name,ct.last_name,ct.email,
          j.name AS journey_name,es.name AS sequence_name
        FROM intent_inbound_submissions s
        JOIN companies c ON c.tenant_id=s.tenant_id AND c.id=s.account_id AND c.client_id=s.client_id
        JOIN clients cl ON cl.tenant_id=c.tenant_id AND cl.id=c.client_id
        LEFT JOIN contacts ct ON ct.tenant_id=s.tenant_id AND ct.id=s.contact_id
          AND ct.company_id=c.id AND ct.client_id=c.client_id
        LEFT JOIN intent_inbound_manual_routes mr ON mr.tenant_id=s.tenant_id AND mr.submission_id=s.id
          AND s.routing_status='routed'
        LEFT JOIN intent_inbound_routing_rules rr ON rr.tenant_id=s.tenant_id AND rr.id=s.routed_rule_id
          AND s.routing_status='routed'
        LEFT JOIN journeys j ON j.tenant_id=s.tenant_id AND j.client_id=s.client_id
          AND j.id=COALESCE(mr.journey_id,rr.journey_id)
        LEFT JOIN email_sequences es ON es.tenant_id=s.tenant_id
          AND es.id=COALESCE(mr.sequence_id,rr.sequence_id)
        WHERE s.tenant_id=$1 AND s.account_id=ANY($2::int[])
          AND s.classification IN ('hot','warm')
        ORDER BY COALESCE(s.submitted_at,s.created_at) DESC,s.id DESC`, [tenantId, accountIds]),
      pool.query<any>(`SELECT e.id,e.account_id,e.product_id,e.evidence_kind,e.event_type,e.excerpt,
          e.source_url,e.occurred_at,e.confidence,e.review_status,e.context,e.raw_evidence
        FROM intent_evidence e
        JOIN companies c ON c.tenant_id=e.tenant_id AND c.id=e.account_id
        JOIN clients cl ON cl.tenant_id=c.tenant_id AND cl.id=c.client_id
        WHERE e.tenant_id=$1 AND e.account_id=ANY($2::int[])
          AND e.review_status<>'rejected'
          AND e.evidence_kind NOT IN ('lead_form','event_feedback','event_questionnaire','product_buy_intent')
        ORDER BY e.occurred_at DESC,e.id DESC`, [tenantId, accountIds]),
    ]);
    const byAccount = (rows: any[]) => {
      const map = new Map<number, any[]>();
      for (const row of rows) {
        const id = Number(row.account_id);
        map.set(id, [...(map.get(id) ?? []), row]);
      }
      return map;
    };
    const submissionsByAccount = byAccount(submissionRows.rows);
    const evidenceByAccount = byAccount(evidenceRows.rows);
    for (const [index, row] of batch.rows.entries()) {
    const productRow = catalog.find(item => item.id === Number(row.product_id));
    if (!productRow) continue;
    const accountEvidence = classifyEvidenceRows(evidenceByAccount.get(Number(row.account_id)) ?? [], productRow, categoryConfig, catalog);
    let status: "hot" | "warm" | "review", source: string, reason: string;
    let evidenceLink: string | null = null;
    let journeyName: string | null = null;
    let sequenceName: string | null = null;
    let matchedInterest: string | null = null;
    if (row.first_status) {
      const matching = (submissionsByAccount.get(Number(row.account_id)) ?? [])
        .filter((submission: any) => inboundMatches(submission.product_interest, productRow, catalog))
        .sort((a: any, b: any) => {
          const aHot = a.classification === "hot" && isFreshInboundHot(a.action_at);
          const bHot = b.classification === "hot" && isFreshInboundHot(b.action_at);
          return Number(bHot) - Number(aHot) ||
            new Date(b.action_at).getTime() - new Date(a.action_at).getTime();
        })[0];
      if (matching) {
        matchedInterest = matching.product_interest;
        status = matching.classification === "hot" && !isFreshInboundHot(matching.action_at)
          ? "warm" : matching.classification;
        source = matching.form_type ?? "inbound";
        journeyName = matching.journey_name ?? null;
        sequenceName = matching.sequence_name ?? null;
        reason = matching.classification === "hot" && status === "warm"
          ? "Earlier buying interest needs a fresh confirmation before sales handoff."
          : matching.classification_reason;
        row.latest_at = matching.action_at;
        row.contact = matching.contact_id ? {
          id: Number(matching.contact_id), name: nameOf(matching), email: matching.email,
        } : null;
        const external = accountEvidence;
        if (status !== "hot" && external.status === "hot") {
          status = "hot";
          source = "monitoring";
          journeyName = null;
          sequenceName = null;
          reason = external.reason;
          const qualifying = external.rows.find((item: any) =>
            external.qualifyingEvidenceIds.includes(Number(item.id)));
          if (qualifying) {
            row.latest_at = qualifying.occurred_at;
            evidenceLink = qualifying.source_url;
          }
        }
      } else {
        const external = accountEvidence;
        if (!external.rows.length) continue;
        status = external.status;
        source = status === "review" ? "monitoring_review" : "monitoring";
        reason = external.reason;
        const qualifying = external.rows.find((item: any) =>
          external.qualifyingEvidenceIds.includes(Number(item.id))) ?? external.rows[0];
        row.latest_at = qualifying.occurred_at;
        evidenceLink = qualifying.source_url;
      }
    } else {
      const evaluated = accountEvidence;
      status = evaluated.status;
      source = evaluated.status === "review" ? "monitoring_review" : "monitoring";
      reason = evaluated.reason;
      const qualifying = evaluated.rows.find((item: any) =>
        evaluated.qualifyingEvidenceIds.includes(Number(item.id))) ?? evaluated.rows[0];
      evidenceLink = qualifying?.source_url ?? null;
    }
    const categorySource = matchedInterest?.trim()
      ? matchedInterest
      : (() => {
        const evidence = accountEvidence.rows.find((item: any) =>
          accountEvidence.qualifyingEvidenceIds.includes(Number(item.id))) ?? accountEvidence.rows[0];
        if (!evidence) return productRow.name;
        const context = evidence.context && typeof evidence.context === "object" ? evidence.context : {};
        return String(context.productInterest ?? context.product_interest ?? context.productName ??
          context.product_name ?? context.interest ?? evidence.excerpt ?? productRow.name);
      })();
    const categoryName = categoryForOpportunity(categorySource, productRow, categoryConfig);
    const item: Opportunity = {
      accountId: Number(row.account_id), accountName: row.account_name, clientId: Number(row.client_id),
      productId: productRow.id, productName: productRow.name, categoryId: productRow.category_id,
      categoryName, status, source, reason, contact: row.contact ?? null,
      journeyName, sequenceName,
      score: { people: 0, monitoring: 0, total: 0 },
      latestActionAt: row.latest_at ? new Date(row.latest_at).toISOString() : null,
      nextStep: status === "hot" ? "Hand off to sales with the qualifying evidence."
        : status === "warm" ? "Confirm product need, ownership, and purchase timing."
          : "Review product relevance and evidence quality before qualification.",
      handoffStatus: null, evidenceLink,
    };
    if ((!filters.categoryName || item.categoryName === filters.categoryName) &&
        (!preview || !preview.status || item.status === preview.status)) {
      if (!preview || matched >= (preview.skip ?? 0)) classified.push(item);
      matched++;
      if (preview && classified.length >= preview.count) {
        if (preview.scan) preview.scan.nextOffset = rawOffset - batch.rows.length + index + 1;
        return classified;
      }
    }
    }
    if (batch.rows.length < Math.min(batchSize, scanEnd - (rawOffset - batch.rows.length))) break;
  }
  if (preview?.scan && rawOffset >= scanEnd) preview.scan.nextOffset = rawOffset;
  return classified;
}

router.get("/intent/opportunities/priority", async (req, res): Promise<void> => {
  const tenantId = userTenant(req);
  const status = typeof req.query.status === "string" ? req.query.status : null;
  if (status && !["hot", "warm", "review"].includes(status)) {
    res.status(400).json({ error: "status must be hot, warm, or review" }); return;
  }
  const categoryName = requestedCategoryName(req.query.categoryName);
  if (categoryName === undefined) {
    res.status(400).json({ error: `categoryName must be one of ${opportunityCategoryNames.join(", ")}` }); return;
  }
  const previewStatus = status as "hot" | "warm" | "review" | null;
  const categoryConfig = await loadInboundCategoryRules(tenantId);
  // This is a recent dashboard preview, not an exhaustive account queue.
  const scan = { start: 0, maxRows: 50, nextOffset: null as number | null, batchSize: 50 };
  const candidates = await classifyCandidates(tenantId, {
    clientId: null, productId: null, categoryId: null, categoryName,
    accountId: null, search: null,
  }, { count: 5, status: previewStatus, scan, recentEvidenceLimit: 300 }, categoryConfig);
  const selected = candidates.filter(item => !previewStatus || item.status === previewStatus).slice(0, 5);
  const items = await Promise.all(selected.map(async item => {
    const score = await opportunityScores(tenantId, item.accountId, item.productId, categoryConfig);
    return { ...item, score: { people: score.people, monitoring: score.monitoring, total: score.total } };
  }));
  res.json({ items, limited: scan.nextOffset !== null });
});

async function candidatePairs(tenantId: number, filters: CandidateFilters & {
  status: "hot" | "warm" | "review" | null; limit: number | null; offset: number;
  cursor?: number;
}) {
  const categoryConfig = await loadInboundCategoryRules(tenantId);
  // Qualification is written by inbound sync/repair and both manual and automatic
  // evidence review. Read it on every request so a revoked candidate cannot linger
  // in a process-local cache (or on another server instance).
  const scan = filters.cursor == null ? undefined : {
    start: filters.cursor, maxRows: 200, nextOffset: null as number | null,
  };
  const filtered = filters.limit === null
    ? (await classifyCandidates(tenantId, filters, undefined, categoryConfig)).filter(item => !filters.status || item.status === filters.status)
    : await classifyCandidates(tenantId, filters, {
      status: filters.status, skip: scan ? 0 : filters.offset,
      count: filters.limit + (scan ? 0 : 1), scan,
    }, categoryConfig);
  const hasMore = scan ? scan.nextOffset !== null : filters.limit !== null && filtered.length > filters.limit;
  const selected = filters.limit === null ? filtered.slice(filters.offset) : filtered.slice(0, filters.limit);
  const items = await Promise.all(selected.map(async item => {
    const [score, handoff] = await Promise.all([
      opportunityScores(tenantId, item.accountId, item.productId, categoryConfig),
      pool.query<any>(`SELECT handoff_status FROM intent_opportunity_handoffs
        WHERE tenant_id=$1 AND account_id=$2 AND product_id=$3
        ORDER BY created_at DESC,id DESC LIMIT 1`, [tenantId, item.accountId, item.productId]),
    ]);
    return {
      ...item,
      score: { people: score.people, monitoring: score.monitoring, total: score.total },
      handoffStatus: handoff.rows[0]?.handoff_status ?? null,
    };
  }));
  return { items, hasMore, nextCursor: scan?.nextOffset ?? null,
    ...(filters.limit === null ? { total: filtered.length } : {}) };
}

router.get("/intent/opportunities/monitored-accounts", async (req, res): Promise<void> => {
  const tenantId = userTenant(req);
  const page = Math.max(1, positiveInt(req.query.page) ?? 1);
  const pageSize = Math.min(25, Math.max(1, positiveInt(req.query.pageSize) ?? 5));
  const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : "";
  const clientId = req.query.clientId == null ? null : positiveInt(req.query.clientId);
  const accountId = req.query.accountId == null ? null : positiveInt(req.query.accountId);
  const completeResearch = req.query.completeResearch === "true";
  if(req.query.completeResearch!=null && !["true","false"].includes(String(req.query.completeResearch))){
    res.status(400).json({error:"completeResearch must be true or false"});return;
  }
  if (req.query.accountId != null && !accountId) {
    res.status(400).json({ error: "accountId must be a positive integer" }); return;
  }
  if (req.query.clientId != null && !clientId) {
    res.status(400).json({ error: "clientId must be a positive integer" }); return;
  }
  // "Monitored" here means a research run actually reached this account, not merely
  // that it was selected in a schedule. Keep pending/failed work visible as such.
  const where = `c.tenant_id=$1 AND c.client_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM clients cl WHERE cl.tenant_id=c.tenant_id AND cl.id=c.client_id)
    AND ($2::int IS NULL OR c.client_id=$2)
    AND ($3::text='' OR c.name ILIKE '%'||$3||'%' OR c.domain ILIKE '%'||$3||'%')
    AND ($4::int IS NULL OR c.id=$4)
    AND EXISTS (SELECT 1 FROM intent_research_run_accounts ra
      WHERE ra.tenant_id=c.tenant_id AND (
        (ra.account_id=c.id AND COALESCE(ra.summary->'researchSubject'->>'scope','member')<>'parent')
        OR ra.summary->'researchSubject'->>'accountId'=c.id::text))`;
  const researchWhere=where+(completeResearch?` AND EXISTS (SELECT 1 FROM intent_evidence ready
    WHERE ready.tenant_id=c.tenant_id AND ready.account_id=c.id
      AND ready.evidence_kind='public_event' AND ready.review_status='approved')`:"");
  const accountSql=`SELECT c.id,c.name,c.domain,c.client_id AS "clientId",
        (SELECT cl.name FROM clients cl WHERE cl.tenant_id=c.tenant_id AND cl.id=c.client_id) AS "clientName",
        c.last_researched_at AS "lastResearchedAt",
        (SELECT count(*)::int FROM intent_evidence e
          WHERE e.tenant_id=c.tenant_id AND e.account_id=c.id
            AND e.evidence_kind='public_event') AS "storedFindingCount",
        (SELECT ra.status FROM intent_research_run_accounts ra
          WHERE ra.tenant_id=c.tenant_id AND (
            (ra.account_id=c.id AND COALESCE(ra.summary->'researchSubject'->>'scope','member')<>'parent')
            OR ra.summary->'researchSubject'->>'accountId'=c.id::text)
          ORDER BY ra.id DESC LIMIT 1) AS "latestRunStatus",
        COALESCE((SELECT json_agg(finding) FROM (
          SELECT e.id,e.excerpt,e.source_url AS "sourceUrl",e.occurred_at AS "occurredAt",
            e.event_type AS "eventType",e.review_status AS "reviewStatus",e.context,e.raw_evidence
          FROM intent_evidence e
          WHERE e.tenant_id=c.tenant_id AND e.account_id=c.id
            AND e.evidence_kind='public_event'
          ORDER BY e.occurred_at DESC,e.id DESC LIMIT 100
        ) finding),'[]'::json) AS findings,
        EXISTS (SELECT 1 FROM intent_inbound_submissions s
          WHERE s.tenant_id=c.tenant_id AND s.account_id=c.id
            AND s.classification IN ('hot','warm')) AS "hasInbound"
      FROM companies c WHERE ${researchWhere}
      ORDER BY c.last_researched_at DESC NULLS LAST,c.id DESC LIMIT $5 OFFSET $6`;
  const scanSize=completeResearch?100:pageSize;
  const [count, accounts] = await Promise.all([
    pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM companies c WHERE ${researchWhere}`,
      [tenantId, clientId, search, accountId]),
    pool.query<any>(accountSql,
      [tenantId, clientId, search, accountId, scanSize, completeResearch?0:(page - 1) * pageSize]),
  ]);
  const now=new Date();
  const toItem=({ findings, storedFindingCount, ...account }:any) => {
    const researchContext = monitoredAccountContext(findings, now, account, storedFindingCount);
    return { ...account, latestSignal: researchContext.kind === "no_recent_findings" ? null : researchContext.summary, researchContext };
  };
  if(completeResearch){
    // Assess stored results in bounded batches before paginating. Filtering a
    // single page would leave empty pages and an inflated dashboard total.
    let batch=accounts.rows,offset=0,total=0;
    const items:ReturnType<typeof toItem>[]=[];
    const start=(page-1)*pageSize;
    while(batch.length){
      for(const row of batch){
        const item=toItem(row);
        if(!hasCompleteMonitoredResearch(item.researchContext))continue;
        if(total>=start&&items.length<pageSize)items.push(item);
        total++;
      }
      offset+=batch.length;
      if(batch.length<scanSize||offset>=Number(count.rows[0]?.total??0))break;
      batch=(await pool.query<any>(accountSql,[tenantId,clientId,search,accountId,scanSize,offset])).rows;
    }
    res.json({total,page,pageSize,items});return;
  }
  const items=accounts.rows.map(toItem);
  res.json({ total: count.rows[0]?.total ?? 0, page, pageSize, items });
});

router.get("/intent/opportunities", async (req, res): Promise<void> => {
  const tenantId = userTenant(req);
  const page = Math.max(1, positiveInt(req.query.page) ?? 1);
  const pageSize = Math.min(100, Math.max(1, positiveInt(req.query.pageSize) ?? 25));
  // The first page is bounded even for older callers that do not yet send a cursor.
  const cursor = req.query.cursor == null ? (page === 1 ? 0 : undefined) : Number(req.query.cursor);
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) {
    res.status(400).json({ error: "cursor must be a non-negative integer" }); return;
  }
  const clientId = req.query.clientId == null ? null : positiveInt(req.query.clientId);
  const productId = req.query.productId == null ? null : positiveInt(req.query.productId);
  const categoryId = req.query.categoryId == null ? null : positiveInt(req.query.categoryId);
  const categoryName = requestedCategoryName(req.query.categoryName);
  if ((req.query.clientId != null && !clientId) || (req.query.productId != null && !productId) ||
      (req.query.categoryId != null && !categoryId)) {
    res.status(400).json({ error: "clientId, productId, and categoryId must be positive integers" }); return;
  }
  if (categoryName === undefined) {
    res.status(400).json({ error: `categoryName must be one of ${opportunityCategoryNames.join(", ")}` }); return;
  }
  const statusFilter = typeof req.query.status === "string" ? req.query.status : null;
  if (statusFilter && !["hot", "warm", "review"].includes(statusFilter)) {
    res.status(400).json({ error: "status must be hot, warm, or review" }); return;
  }
  const { items, hasMore, nextCursor } = await candidatePairs(tenantId, {
    clientId, productId, categoryId, categoryName, accountId: null,
    search: typeof req.query.search === "string" ? req.query.search.trim() : null,
    status: statusFilter as "hot" | "warm" | "review" | null,
    limit: pageSize, offset: (page - 1) * pageSize, cursor,
  });
  res.json({ items, hasMore, nextCursor, page, pageSize });
});

router.get("/intent/opportunities/:accountId/timeline", async (req, res): Promise<void> => {
  const tenantId = userTenant(req);
  const accountId = positiveInt(req.params.accountId);
  const productId = req.query.productId == null ? null : positiveInt(req.query.productId);
  const contactId = req.query.contactId == null ? null : positiveInt(req.query.contactId);
  const dateFrom = req.query.dateFrom == null ? null : validDate(req.query.dateFrom);
  const dateTo = req.query.dateTo == null ? null : validDate(req.query.dateTo);
  if (!accountId || (req.query.productId != null && !productId) ||
      (req.query.contactId != null && !contactId) ||
      (req.query.dateFrom != null && !dateFrom) || (req.query.dateTo != null && !dateTo)) {
    res.status(400).json({ error: "Invalid timeline filter" }); return;
  }
  const account = await pool.query<any>(`SELECT c.id,c.name,c.client_id FROM companies c
    JOIN clients cl ON cl.id=c.client_id AND cl.tenant_id=c.tenant_id
    WHERE c.tenant_id=$1 AND c.id=$2`, [tenantId, accountId]);
  if (!account.rows.length) { res.status(404).json({ error: "Account not found" }); return; }
  const accountRow = account.rows[0];
  const productRow = productId ? await product(tenantId, productId) : null;
  if (productId && !productRow) { res.status(404).json({ error: "Product not found for this tenant" }); return; }
  if (contactId) {
    const contact = await pool.query(`SELECT 1 FROM contacts WHERE tenant_id=$1 AND id=$2
      AND company_id=$3 AND client_id=$4`, [tenantId, contactId, accountId, accountRow.client_id]);
    if (!contact.rows.length) { res.status(404).json({ error: "Contact not found for this account and client" }); return; }
  }
  const catalog = await scopedCatalog(tenantId);
  const [submissions, evidence, actions, signals] = await Promise.all([
    pool.query<any>(`SELECT s.id,s.form_type,s.classification,s.classification_reason,s.product_interest,
        COALESCE(s.submitted_at,s.created_at) AS occurred_at,s.created_at AS imported_at,
        ct.id AS contact_id,trim(concat_ws(' ',ct.first_name,ct.last_name)) AS contact_name,
        ct.email,s.raw_fields,s.event_feedback
      FROM intent_inbound_submissions s
      JOIN companies c ON c.tenant_id=s.tenant_id AND c.id=s.account_id AND c.client_id=s.client_id
      JOIN clients cl ON cl.tenant_id=c.tenant_id AND cl.id=c.client_id
      LEFT JOIN contacts ct ON ct.tenant_id=s.tenant_id AND ct.id=s.contact_id
        AND ct.company_id=c.id AND ct.client_id=c.client_id
      WHERE s.tenant_id=$1 AND s.account_id=$2 AND s.classification IN ('hot','warm')
        AND ($3::int IS NULL OR s.contact_id=$3)
        AND ($4::date IS NULL OR COALESCE(s.submitted_at,s.created_at)>=$4::date)
        AND ($5::date IS NULL OR COALESCE(s.submitted_at,s.created_at)<$5::date+INTERVAL '1 day')
      ORDER BY occurred_at DESC,s.id DESC LIMIT 1000`,
      [tenantId, accountId, contactId, dateFrom, dateTo]),
    pool.query<any>(`SELECT e.id,e.evidence_kind,e.event_type,e.provider,ct.id AS contact_id,
        trim(concat_ws(' ',ct.first_name,ct.last_name)) AS contact_name,e.confidence AS points,
        e.context,e.excerpt,e.source_url,e.occurred_at,e.created_at AS imported_at,e.product_id,
        p.category_id
      FROM intent_evidence e
      JOIN companies c ON c.tenant_id=e.tenant_id AND c.id=e.account_id
      JOIN clients cl ON cl.tenant_id=c.tenant_id AND cl.id=c.client_id
      LEFT JOIN contacts ct ON ct.tenant_id=e.tenant_id AND ct.id=e.contact_id
        AND ct.company_id=c.id AND ct.client_id=c.client_id
      LEFT JOIN intent_products p ON p.tenant_id=e.tenant_id AND p.id=e.product_id
      WHERE e.tenant_id=$1 AND e.account_id=$2 AND e.review_status<>'rejected'
        AND ($3::int IS NULL OR e.contact_id=$3)
        AND ($4::int IS NULL OR e.product_id=$4 OR (e.product_id IS NULL AND EXISTS (
          SELECT 1 FROM intent_products ep
          JOIN intent_product_categories epc ON epc.tenant_id=ep.tenant_id AND epc.id=ep.category_id
          WHERE ep.tenant_id=$1 AND ep.id=$4
            AND lower(epc.name)=lower(COALESCE(e.context->>'category',e.context->>'categoryName',''))
        )))
        AND ($5::date IS NULL OR e.occurred_at >= $5::date)
        AND ($6::date IS NULL OR e.occurred_at < $6::date+INTERVAL '1 day')
      ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1000`,
      [tenantId, accountId, contactId, productId, dateFrom, dateTo]),
    pool.query<any>(`SELECT ae.id,ae.event_type,'activity'::text AS source,ae.contact_id,
        trim(concat_ws(' ',ct.first_name,ct.last_name)) AS contact_name,
        ae.points_earned AS points,ae.description,ae.page_url AS url,ae.created_at AS occurred_at,
        ae.created_at AS imported_at,ae.metadata::jsonb->>'productId' AS product_id
      FROM activity_events ae
      JOIN contacts ct ON ct.tenant_id=ae.tenant_id AND ct.id=ae.contact_id
      JOIN companies c ON c.tenant_id=ct.tenant_id AND c.id=ct.company_id
      JOIN clients cl ON cl.tenant_id=c.tenant_id AND cl.id=c.client_id
      WHERE ae.tenant_id=$1 AND c.id=$2 AND c.client_id=ct.client_id
        AND (ae.client_id IS NULL OR ae.client_id=c.client_id)
        AND ct.is_anonymous=false AND COALESCE(ae.is_bot,false)=false
        AND ($3::int IS NULL OR ae.contact_id=$3)
        AND ($4::int IS NULL OR ae.metadata::jsonb->>'productId'=$4::text)
        AND ($5::date IS NULL OR ae.created_at >= $5::date)
        AND ($6::date IS NULL OR ae.created_at < $6::date+INTERVAL '1 day')
        AND ae.event_type IN ('page_view','email_open','email_click')
      ORDER BY ae.created_at DESC,ae.id DESC LIMIT 1000`,
      [tenantId, accountId, contactId, productId, dateFrom, dateTo]),
    pool.query<any>(`SELECT s.id,s.contact_id,s.source,s.summary,s.occurred_at,s.created_at AS imported_at,
        s.product_id,st.key,st.max_points,s.strength,s.payload,ct.email,
        trim(concat_ws(' ',ct.first_name,ct.last_name)) AS contact_name,ct.tags,p.category_id
      FROM intent_signals s
      JOIN intent_signal_types st ON st.tenant_id=s.tenant_id AND st.id=s.signal_type_id
      JOIN contacts ct ON ct.tenant_id=s.tenant_id AND ct.id=s.contact_id
      JOIN companies c ON c.tenant_id=ct.tenant_id AND c.id=ct.company_id
      JOIN clients cl ON cl.tenant_id=c.tenant_id AND cl.id=c.client_id
      LEFT JOIN intent_products p ON p.tenant_id=s.tenant_id AND p.id=s.product_id
      WHERE s.tenant_id=$1 AND s.account_id=$2 AND c.id=$2 AND s.contact_id IS NOT NULL
        AND c.client_id=ct.client_id AND (s.client_id IS NULL OR s.client_id=c.client_id)
        AND ct.is_anonymous=false
        AND ($3::int IS NULL OR s.contact_id=$3)
        AND ($4::int IS NULL OR s.product_id=$4)
        AND ($5::date IS NULL OR s.occurred_at >= $5::date)
        AND ($6::date IS NULL OR s.occurred_at < $6::date+INTERVAL '1 day')
        AND s.product_id IS NOT NULL AND st.category='questionnaire'
      ORDER BY s.occurred_at DESC,s.id DESC LIMIT 1000`,
      [tenantId, accountId, contactId, productId, dateFrom, dateTo]),
  ]);
  const matchingSubmissions = submissions.rows.filter((row: any) =>
    !productRow || inboundMatches(row.product_interest, productRow, catalog));
  const eligibleMonitoringEvidence = new Set<number>();
  const evidenceIdsByProduct = new Map<number, Set<number>>();
  const productsById = new Map(catalog.map(item => [item.id, item]));
  for (const row of evidence.rows) {
    const matchedProducts = productRow
      ? [productRow]
      : row.product_id
        ? [productsById.get(Number(row.product_id))].filter((item): item is Product => Boolean(item))
        : catalog.filter(item => item.category_name.toLowerCase() ===
          String(row.context?.category ?? row.context?.categoryName ?? "").toLowerCase());
    for (const matchedProduct of matchedProducts) {
      const ids = evidenceIdsByProduct.get(matchedProduct.id) ?? new Set<number>();
      ids.add(Number(row.id));
      evidenceIdsByProduct.set(matchedProduct.id, ids);
    }
  }
  for (const [productIdForEvidence, ids] of evidenceIdsByProduct) {
    const matchedProduct = productsById.get(productIdForEvidence);
    if (!matchedProduct) continue;
    const qualification = await evidenceStatus(tenantId, accountId, matchedProduct);
    for (const id of ids) {
      if (qualification.qualifyingEvidenceIds.includes(id)) eligibleMonitoringEvidence.add(id);
    }
  }
  const events: any[] = [
    ...matchingSubmissions.map((row: any) => ({
      id: `inbound-${row.id}`, type: row.form_type, source: "inbound",
      contactId: row.contact_id, contactName: row.contact_name, points: 0,
      tags: [], evidence: row.classification_reason, url: null,
      occurredAt: row.occurred_at, importedAt: row.imported_at,
      productId: productRow?.id ?? null, categoryId: productRow?.category_id ?? null,
    })),
    ...evidence.rows.filter((row: any) => !productRow || Number(row.product_id) === productRow.id ||
      (!row.product_id && String(row.context?.category ?? row.context?.categoryName ?? "").toLowerCase() === productRow.category_name.toLowerCase()))
      .map((row: any) => ({
        id: `evidence-${row.id}`, type: row.event_type ?? row.evidence_kind,
        source: row.provider, contactId: row.contact_id, contactName: row.contact_name,
        points: row.evidence_kind === "public_event" && eligibleMonitoringEvidence.has(Number(row.id))
          ? Number(row.points) || 0 : 0,
        tags: row.context?.tags ?? [],
        evidence: row.excerpt, url: row.source_url, occurredAt: row.occurred_at,
        importedAt: row.imported_at, productId: row.product_id, categoryId: row.category_id,
      })),
    ...actions.rows.map((row: any) => ({
      id: `activity-${row.id}`, type: row.event_type, source: row.source,
      contactId: row.contact_id, contactName: row.contact_name,
      points: Math.max(0, Number(row.points) || 0), tags: [], evidence: row.description, url: row.url,
      occurredAt: row.occurred_at, importedAt: row.imported_at,
      productId: row.product_id ? Number(row.product_id) : null,
      categoryId: productRow?.category_id ?? null,
    })),
    ...signals.rows.filter((row: any) => !productRow || Number(row.product_id) === productRow.id)
      .map((row: any) => ({
        id: `signal-${row.id}`, type: row.key, source: row.source,
        contactId: row.contact_id, contactName: row.contact_name,
        points: Number((Number(row.max_points) * Number(row.strength) / 100).toFixed(2)),
        tags: row.tags ?? [], evidence: row.summary ?? row.payload?.answer?.value ?? null,
        url: null, occurredAt: row.occurred_at, importedAt: row.imported_at,
        productId: row.product_id, categoryId: row.category_id,
      })),
  ].sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
  let scoredProducts = productRow ? [productRow] : [];
  if (!productRow) {
    const usedProducts = await pool.query<any>(`SELECT product_id AS id FROM intent_signals
        WHERE tenant_id=$1 AND account_id=$2 AND product_id IS NOT NULL
      UNION
      SELECT CASE WHEN ae.metadata::jsonb->>'productId' ~ '^[0-9]+$'
        THEN (ae.metadata::jsonb->>'productId')::int END AS id
      FROM activity_events ae
      JOIN contacts ct ON ct.tenant_id=ae.tenant_id AND ct.id=ae.contact_id
      JOIN companies c ON c.tenant_id=ct.tenant_id AND c.id=ct.company_id
      JOIN clients cl ON cl.tenant_id=c.tenant_id AND cl.id=c.client_id
      WHERE ae.tenant_id=$1 AND c.id=$2 AND COALESCE(ae.is_bot,false)=false
        AND ae.event_type IN ('page_view','email_open','email_click')
      UNION
      SELECT product_id AS id FROM intent_evidence
        WHERE tenant_id=$1 AND account_id=$2 AND product_id IS NOT NULL
          AND review_status='approved' AND evidence_kind='public_event'
      UNION
      SELECT p.id FROM intent_evidence e
      JOIN intent_product_categories pc ON pc.tenant_id=e.tenant_id
        AND lower(pc.name)=lower(COALESCE(e.context->>'category',e.context->>'categoryName',''))
      JOIN intent_products p ON p.tenant_id=pc.tenant_id AND p.category_id=pc.id AND p.active=true
      WHERE e.tenant_id=$1 AND e.account_id=$2 AND e.product_id IS NULL
        AND e.review_status='approved' AND e.evidence_kind='public_event'`,
    [tenantId, accountId]);
    const usedIds = new Set(usedProducts.rows.map((row: any) => Number(row.id)).filter(Number.isSafeInteger));
    scoredProducts = catalog.filter(item => usedIds.has(item.id));
  }
  const categoryConfig = await loadInboundCategoryRules(tenantId);
  const productScores = await Promise.all(scoredProducts.map(item =>
    opportunityScores(tenantId, accountId, item.id, categoryConfig)));
  const peopleById = new Map<number, any>();
  let peopleScore = 0;
  const monitoringEvents = new Map<number, number>();
  for (const score of productScores) {
    peopleScore += score.people;
    for (const contribution of score.monitoringContributions) {
      monitoringEvents.set(contribution.id, contribution.points);
    }
    for (const contact of score.contacts) {
      const prior = peopleById.get(contact.id);
      peopleById.set(contact.id, prior
        ? { ...prior, score: prior.score + contact.score }
        : { ...contact });
    }
  }
  const monitoringScore = [...monitoringEvents.values()].reduce((sum, points) => sum + points, 0);
  const scores = {
    people: peopleScore, monitoring: monitoringScore, total: peopleScore + monitoringScore,
    contacts: [...peopleById.values()],
  };
  res.json({
    accountName: accountRow.name,
    score: { people: scores.people, monitoring: scores.monitoring, total: scores.total },
    people: scores.contacts.map(({ id, name, email, score, tags }: any) => ({ id, name, email, score, tags })),
    events,
  });
});

router.get("/intent/opportunities/handoff.csv", async (req, res): Promise<void> => {
  const tenantId = userTenant(req);
  const ids = ["clientId", "productId", "categoryId"].map(key =>
    req.query[key] == null ? null : positiveInt(req.query[key]));
  const categoryName = requestedCategoryName(req.query.categoryName);
  if (ids.some((id, i) => req.query[["clientId", "productId", "categoryId"][i]] != null && !id)) {
    res.status(400).json({ error: "Filters must be positive integers" }); return;
  }
  if (categoryName === undefined) {
    res.status(400).json({ error: `categoryName must be one of ${opportunityCategoryNames.join(", ")}` }); return;
  }
  if (req.query.status != null && req.query.status !== "hot") {
    res.status(400).json({ error: "CSV handoff only supports status=hot" }); return;
  }
  const matches = await candidatePairs(tenantId, {
    clientId: ids[0], productId: ids[1], categoryId: ids[2], categoryName, accountId: null, search: null,
    status: "hot", limit: null, offset: 0,
  });
  const hot = matches.items;
  const now = new Date().toISOString();
  const exportId = randomUUID();
  for (const item of hot) {
    const idempotencyKey = `csv:${exportId}:${item.accountId}:${item.productId}`;
    await pool.query(`INSERT INTO intent_opportunity_handoffs
      (tenant_id,account_id,client_id,product_id,method,spreadsheet_id,range_name,
       idempotency_key,handoff_status,source,snapshot,created_by,created_at,completed_at)
      VALUES($1,$2,$3,$4,'csv',NULL,NULL,$5,'completed',$6,$7,$8,NOW(),NOW())
      ON CONFLICT (tenant_id,idempotency_key) DO NOTHING`,
    [tenantId, item.accountId, item.clientId, item.productId, idempotencyKey, item.source, item,
      positiveInt((req.user as any)?.id)]);
  }
  const header = ["Account", "Client ID", "Product", "Category", "Status", "Source", "Reason",
    "Contact", "Email", "Evidence event time", "Handoff time", "Opportunity score", "Evidence link"];
  const lines = [header, ...hot.map(item => [
    item.accountName, item.clientId, item.productName, item.categoryName, item.status,
    item.source, item.reason, item.contact?.name ?? "", item.contact?.email ?? "",
    item.latestActionAt ?? "", now, item.score.total, item.evidenceLink ?? "",
  ])].map(row => row.map(csv).join(","));
  res.type("text/csv").set("Content-Disposition", 'attachment; filename="hot-opportunities.csv"').send(lines.join("\r\n"));
});

router.post("/intent/opportunities/handoff", async (req, res): Promise<void> => {
  const tenantId = userTenant(req);
  const accountId = positiveInt(req.body?.accountId);
  const productId = positiveInt(req.body?.productId);
  const spreadsheetIdInput = req.body?.spreadsheetId;
  const rawRange = req.body?.range;
  const range = typeof req.body?.range === "string" ? req.body.range.trim() : "";
  if (!accountId || !productId || typeof spreadsheetIdInput !== "string" || !spreadsheetIdInput.trim() ||
      (rawRange != null && typeof rawRange !== "string") || range.length > 200 ||
      (range && !/^[A-Za-z0-9_ '!:.$]+$/.test(range))) {
    res.status(400).json({ error: "Provide valid accountId, productId, spreadsheetId, and optional A1 range" }); return;
  }
  let spreadsheetId: string;
  try { spreadsheetId = googleSpreadsheetId(spreadsheetIdInput); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Invalid spreadsheet ID" }); return; }
  let tenantConnection;
  try {
    tenantConnection = await connectors.listConnections({ connector_names: "google-sheet" });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Unable to validate Google Sheets connection" }); return;
  }
  if (!tenantConnection.some(connection => connection.connector_name === "google-sheet" &&
      (!connection.status || connection.status === "connected" || connection.status === "active"))) {
    res.status(403).json({ error: "No authorized Google Sheets connection is available" }); return;
  }
  const productRow = await product(tenantId, productId);
  if (!productRow) { res.status(404).json({ error: "Product not found for this tenant" }); return; }
   const opportunityFilters = {
    clientId: null, productId, categoryId: productRow.category_id, accountId, search: null,
     status: "hot" as const, limit: null, offset: 0,
   };
   const page = await candidatePairs(tenantId, opportunityFilters);
  const opportunity = page.items.find(item => item.accountId === accountId && item.status === "hot");
  if (!opportunity) { res.status(409).json({ error: "Only a currently qualified Hot account-product opportunity can be handed off" }); return; }
  const key = `sheets:${accountId}:${productId}:${spreadsheetId}:${range || "append"}`;
  const claimed = await pool.query<any>(`INSERT INTO intent_opportunity_handoffs
      (tenant_id,account_id,client_id,product_id,method,spreadsheet_id,range_name,
       idempotency_key,handoff_status,source,snapshot,created_by,created_at)
    VALUES($1,$2,$3,$4,'sheets',$5,$6,$7,'pending',$8,$9,$10,NOW())
    ON CONFLICT (tenant_id,idempotency_key) DO NOTHING
    RETURNING id,handoff_status,completed_at`,
  [tenantId, opportunity.accountId, opportunity.clientId, productId, spreadsheetId, range || null,
    key, opportunity.source, opportunity, positiveInt((req.user as any)?.id)]);
  let history = claimed.rows[0];
  if (!history) {
    const existing = await pool.query<any>(`SELECT id,handoff_status,completed_at,created_at
      FROM intent_opportunity_handoffs WHERE tenant_id=$1 AND idempotency_key=$2`,
    [tenantId, key]);
    history = existing.rows[0];
    if (history?.handoff_status === "completed") {
      res.json({ status: "completed", id: history.id, duplicate: true, completedAt: history.completed_at }); return;
    }
    if (history?.handoff_status === "pending" &&
        new Date(history.created_at).getTime() > Date.now() - 15 * 60_000) {
      res.status(202).json({ status: "pending", id: history.id, message: "A handoff for this destination is already in progress" }); return;
    }
    const retry = await pool.query<any>(`UPDATE intent_opportunity_handoffs SET handoff_status='pending',
        created_at=NOW(),completed_at=NULL,error=NULL
      WHERE tenant_id=$1 AND id=$2 AND handoff_status IN ('failed','pending')
        AND (handoff_status='failed' OR created_at<NOW()-INTERVAL '15 minutes')
      RETURNING id,handoff_status,completed_at`,
    [tenantId, history.id]);
    history = retry.rows[0];
    if (!history) {
      res.status(409).json({ error: "Handoff is already being processed" }); return;
    }
  }
  if (history.handoff_status === "completed") {
    res.json({ status: "completed", id: history.id, duplicate: true, completedAt: history.completed_at }); return;
  }
  try {
    const metadataResponse = await connectors.proxy("google-sheet",
      `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=properties.title,spreadsheetUrl,sheets.properties`,
      { method: "GET" });
    if (!metadataResponse.ok) throw new Error(`Destination is not accessible (HTTP ${metadataResponse.status})`);
    const metadata: any = await metadataResponse.json();
    const names = (metadata.sheets ?? []).map((sheet: any) => String(sheet.properties?.title ?? ""));
    const targetRange = range || (names[0] ? `'${names[0].replace(/'/g, "''")}'!A:ZZ` : "");
    if (!targetRange || !names.some((name: string) => targetRange.startsWith(`'${name.replace(/'/g, "''")}'!`) ||
        targetRange.startsWith(`${name}!`))) {
      throw new Error("The requested destination range does not belong to a sheet in this spreadsheet");
    }
    const marker = `opportunity:${accountId}:${productId}`;
    const sheetName = targetRange.startsWith("'")
      ? targetRange.slice(1, targetRange.indexOf("'!")).replace(/''/g, "'")
      : targetRange.slice(0, targetRange.indexOf("!"));
    const scanRange = `'${sheetName.replace(/'/g, "''")}'!A:ZZ`;
    const existingResponse = await connectors.proxy("google-sheet",
      `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(scanRange)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`,
      { method: "GET" });
    if (!existingResponse.ok) throw new Error(`Destination range is not readable (HTTP ${existingResponse.status})`);
    const existing: any = await existingResponse.json();
    const alreadyWritten = (existing.values ?? []).some((row: unknown[]) => row.includes(marker));
    if (!alreadyWritten) {
      const current = (await candidatePairs(tenantId, opportunityFilters)).items
        .find(item => item.accountId === accountId && item.status === "hot");
      if (!current) {
        await pool.query(`UPDATE intent_opportunity_handoffs SET handoff_status='failed',error=$3
          WHERE tenant_id=$1 AND id=$2`,
        [tenantId, history.id, "Opportunity is no longer qualified Hot"]);
        res.status(409).json({ error: "Only a currently qualified Hot account-product opportunity can be handed off" });
        return;
      }
      const row = [current.accountName, current.productName, current.categoryName,
        current.contact?.name ?? "", current.contact?.email ?? "", current.reason,
        current.source, current.latestActionAt ?? "", nowIso(), current.score.total,
        current.evidenceLink ?? "", marker];
      const values = (existing.values ?? []).length
        ? [row]
        : [["Account", "Product", "Category", "Contact", "Email", "Evidence",
          "Source", "Event time", "Handoff time", "Opportunity score", "Evidence URL", "Handoff key"], row];
      const appendResponse = await connectors.proxy("google-sheet",
        `/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(targetRange)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        { method: "POST", body: { majorDimension: "ROWS", values } });
      if (!appendResponse.ok) {
        const detail = (await appendResponse.text()).slice(0, 300);
        throw new Error(`Google Sheets write failed (HTTP ${appendResponse.status})${detail ? `: ${detail}` : ""}`);
      }
    }
    await pool.query(`UPDATE intent_opportunity_handoffs SET handoff_status='completed',
      completed_at=NOW(),error=NULL WHERE tenant_id=$1 AND id=$2`, [tenantId, history.id]);
    res.json({ status: "completed", id: history.id, duplicate: alreadyWritten });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Google Sheets handoff failed";
    await pool.query(`UPDATE intent_opportunity_handoffs SET handoff_status='failed',error=$3
      WHERE tenant_id=$1 AND id=$2`, [tenantId, history.id, message.slice(0, 1000)]);
    res.status(502).json({ status: "failed", id: history.id, error: message });
  }
});

function nowIso() { return new Date().toISOString(); }

router.get("/intent/opportunities/handoffs", async (req, res): Promise<void> => {
  const tenantId = userTenant(req);
  const accountId = req.query.accountId == null ? null : positiveInt(req.query.accountId);
  if (req.query.accountId != null && !accountId) {
    res.status(400).json({ error: "accountId must be a positive integer" }); return;
  }
  const result = await pool.query<any>(`SELECT h.id,h.account_id AS "accountId",c.name AS "accountName",
      h.client_id AS "clientId",h.product_id AS "productId",p.name AS "productName",
      h.method,h.spreadsheet_id AS "spreadsheetId",h.range_name AS range,
      h.handoff_status AS status,h.source,h.error,h.created_at AS "createdAt",
      h.completed_at AS "completedAt",h.snapshot
    FROM intent_opportunity_handoffs h
    JOIN companies c ON c.tenant_id=h.tenant_id AND c.id=h.account_id AND c.client_id=h.client_id
    JOIN clients cl ON cl.tenant_id=c.tenant_id AND cl.id=c.client_id
    JOIN intent_products p ON p.tenant_id=h.tenant_id AND p.id=h.product_id
    WHERE h.tenant_id=$1 AND ($2::int IS NULL OR h.account_id=$2)
    ORDER BY h.created_at DESC,h.id DESC LIMIT 500`, [tenantId, accountId]);
  res.json({ items: result.rows });
});

export default router;