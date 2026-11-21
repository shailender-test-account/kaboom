import { pool } from "@workspace/db";
import { canonicalInboundSubmissionSql } from "./inboundSubmissionDuplicates";
import { hpLeadStatus, positiveProduct, field, text } from "./hpBiImport";
import { parsePurchaseTimeframeMonths, repairInboundProductInterestClassifications } from "./inboundAccounts";

export type Qualification = "Hot" | "Warm" | "Cold" | "Unqualified";
export const strongestQualification = (values: Qualification[]): Qualification =>
  values.includes("Hot") ? "Hot" : values.includes("Warm") ? "Warm" : "Cold";
export const storedPoints = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
export function evidenceQualification(product: unknown, months: unknown, recorded?: unknown): Qualification {
  const status = hpLeadStatus(product, months);
  return status === "hot" ? "Hot" : status === "warm" ? "Warm" : "Cold";
}
function formFields(row: any) {
  const fields: Record<string, unknown> = { ...row.field_values };
  for (const f of row.config?.fields ?? []) {
    const value = row.field_values?.[f.id];
    if (value === undefined) continue;
    for (const key of [f.label, f.mapToBiField, f.mapToContactField]) if (key) fields[key] = value;
  }
  return fields;
}
function formQualification(row: any): Qualification {
  const fields = formFields(row);
  return evidenceQualification(field(fields, "productInterest", "product", "service", "solution"),
    parsePurchaseTimeframeMonths(field(fields, "horizonMonths", "timeframe", "purchase timeframe")),
    row.config?.biLead || row.config?.onSubmit?.createLead ? "Warm" : null);
}

/** Read-only, current ownership-scoped qualification and engagement-point roll-up. */
export async function enrichEngagementContacts(tenantId: number, clientId: number | null, rows: any[], accountIds?: number[]) {
  await repairInboundProductInterestClassifications(tenantId);
  const ids = rows.map(c => Number(c.id));
  const companyIds = accountIds ?? [...new Set(rows.map(c => Number(c.company_id)).filter(Boolean))];
  const byContact = new Map<number, Qualification[]>();
  const byAccount = new Map<number, Qualification[]>();
  const journeyIntent: { accountId: number; product: string | null; category: string | null; status: Qualification }[] = [];
  const add = (row: any, status: Qualification) => {
    if (row.contact_id) {
      const id = Number(row.contact_id);
      byContact.set(id, [...(byContact.get(id) ?? []), status]);
    }
    if (row.account_id) {
      const id = Number(row.account_id);
      byAccount.set(id, [...(byAccount.get(id) ?? []), status]);
    }
  };
  if (ids.length || companyIds.length) {
    const [inbound, leads, forms] = await Promise.all([
      pool.query(`SELECT s.contact_id,s.account_id,s.product_interest,s.affinity_reviews,s.purchase_timeframe_months,s.classification
        FROM intent_inbound_submissions s JOIN companies co ON co.id=s.account_id AND co.tenant_id=s.tenant_id AND co.client_id IS NOT DISTINCT FROM s.client_id
        LEFT JOIN contacts c ON c.id=s.contact_id AND c.tenant_id=s.tenant_id
          AND c.client_id IS NOT DISTINCT FROM s.client_id AND c.company_id=s.account_id AND NOT c.is_anonymous
        WHERE s.tenant_id=$1 AND s.client_id IS NOT DISTINCT FROM $2::int
          AND (c.id=ANY($3::int[]) OR (s.contact_id IS NULL AND s.account_id=ANY($4::int[])))
          AND COALESCE(s.identity_review,'')<>'keep'
          AND ${canonicalInboundSubmissionSql("s")}
          AND COALESCE(s.routing_error,'') NOT ILIKE '%email%another account%'`, [tenantId, clientId, ids, companyIds]),
      pool.query(`SELECT r.contact_id,r.account_id,r.product,r.horizon_months FROM hp_bi_records r
        JOIN companies co ON co.id=r.account_id AND co.tenant_id=r.tenant_id AND co.client_id IS NOT DISTINCT FROM r.client_id
        LEFT JOIN contacts c ON c.id=r.contact_id AND c.tenant_id=r.tenant_id
          AND c.client_id IS NOT DISTINCT FROM r.client_id AND c.company_id=r.account_id AND NOT c.is_anonymous
        WHERE r.tenant_id=$1 AND r.client_id IS NOT DISTINCT FROM $2::int
          AND (c.id=ANY($3::int[]) OR (r.contact_id IS NULL AND r.account_id=ANY($4::int[])))
          AND r.kind='lead'`, [tenantId, clientId, ids, companyIds]),
      pool.query(`SELECT f.contact_id,c.company_id account_id,f.field_values,jf.config FROM form_submissions f
        JOIN contacts c ON c.id=f.contact_id AND c.tenant_id=f.tenant_id AND NOT c.is_anonymous
        JOIN journeys j ON j.id=f.journey_id AND j.tenant_id=f.tenant_id AND j.client_id IS NOT DISTINCT FROM c.client_id
        LEFT JOIN journey_forms jf ON jf.id=f.form_id AND jf.tenant_id=f.tenant_id
        WHERE f.tenant_id=$1 AND c.client_id IS NOT DISTINCT FROM $2::int AND c.id=ANY($3::int[])`,
      [tenantId, clientId, ids]),
    ]);
    inbound.rows.forEach(r => {
      const selected = String(r.product_interest ?? "").split(/[,;|\n]/).some(selection =>
        positiveProduct(selection) && r.affinity_reviews?.[selection.trim()] !== "rejected");
      add(r, evidenceQualification(selected ? r.product_interest : null, r.purchase_timeframe_months, r.classification));
    });
    leads.rows.forEach(r => add(r, evidenceQualification(r.product, r.horizon_months, "Warm")));
    forms.rows.forEach(r => {
      const status = formQualification(r), fields = formFields(r);
      add(r, status);
      journeyIntent.push({ accountId: Number(r.account_id), status,
        product: text(field(fields, "productInterest", "product", "service", "solution")) || null,
        category: text(field(fields, "category")) || null });
    });
  }
  const contacts = rows.map(c => ({
    id: Number(c.id), companyId: c.company_id ? Number(c.company_id) : null,
    name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || c.email || "Unnamed",
    email: c.email, title: c.title, isNew: c.is_new ?? false,
    score: storedPoints(c.lead_score), intentScore: storedPoints(c.intent_score),
    stage: c.stage ?? "pre-aware", tags: Array.isArray(c.tags) ? c.tags : [],
    status: strongestQualification(byContact.get(Number(c.id)) ?? []),
  }));
  return {
    contacts, score: contacts.reduce((sum, c) => sum + c.score, 0),
    status: strongestQualification(contacts.map(c => c.status)),
    tags: [...new Set<string>(contacts.flatMap(c => c.tags))],
    statusForAccounts: (accounts: Set<number>) => strongestQualification(
      [...accounts].flatMap(id => byAccount.get(id) ?? [])),
    companyIds, journeyIntent,
  };
}

export type HistoryScope = { clientId: number | null; companyIds: number[] | null; contactId?: number };
export async function readEngagementHistory(tenantId: number, scope: HistoryScope, page: number, pageSize: number) {
  const params = [tenantId, scope.clientId, scope.companyIds, scope.contactId ?? null];
  const contacts = await pool.query(`SELECT c.id,c.company_id,c.first_name,c.last_name,c.email,c.title,
      c.lead_score,c.intent_score,c.tags,c.stage FROM contacts c
    WHERE c.tenant_id=$1 AND c.client_id IS NOT DISTINCT FROM $2::int AND NOT c.is_anonymous
      AND ($3::int[] IS NULL OR c.company_id=ANY($3::int[])) AND ($4::int IS NULL OR c.id=$4)
    ORDER BY c.id`, params);
  const enriched = await enrichEngagementContacts(tenantId, scope.clientId, contacts.rows, scope.contactId ? [] : scope.companyIds ?? []);
  const result = await pool.query(`WITH scoped AS MATERIALIZED (
    SELECT c.id,c.company_id,concat_ws(' ',c.first_name,c.last_name) name FROM contacts c
    WHERE c.tenant_id=$1 AND c.client_id IS NOT DISTINCT FROM $2::int AND NOT c.is_anonymous
      AND ($3::int[] IS NULL OR c.company_id=ANY($3::int[])) AND ($4::int IS NULL OR c.id=$4)
  ), events AS (
    SELECT 'activity:'||a.id id,c.id contact_id,c.name contact_name,a.created_at occurred_at,
      a.event_type kind,'Activity' source,a.description description,COALESCE(a.score_delta,a.points_earned)::numeric score_delta,
      NULL::numeric old_score,NULL::numeric new_score,a.stage,a.metadata::text metadata,
      j.name journey,a.page_name page,NULL::text product,NULL::text qualification,a.is_bot bot
    FROM activity_events a JOIN scoped c ON c.id=a.contact_id
      LEFT JOIN journeys j ON j.id=a.journey_id AND j.tenant_id=a.tenant_id
    WHERE a.tenant_id=$1 AND (a.client_id IS NULL OR a.client_id IS NOT DISTINCT FROM $2::int)
      AND ($4::int IS NOT NULL OR a.company_id IS NULL OR a.company_id=c.company_id)
    UNION ALL
    SELECT 'inbound:'||s.id,c.id,c.name,COALESCE(s.submitted_at,s.created_at),s.form_type,
      'Questionnaire / event feedback',COALESCE(s.file_name,'Form response'),NULL,NULL,NULL,NULL,
      jsonb_build_object('horizonMonths',s.purchase_timeframe_months,'classification',s.classification,
        'dateOrigin',CASE WHEN s.raw_fields ? '__submissionDateOverride' THEN 'edited'
        WHEN s.submitted_at IS NULL OR s.raw_fields->>'__submissionDateOrigin'='upload' THEN 'upload' ELSE 'source' END)::text,
      NULL,NULL,s.product_interest,
      CASE WHEN s.classification='hot' THEN 'Hot'
        WHEN s.classification='warm' THEN 'Warm' ELSE 'Cold' END,false
    FROM intent_inbound_submissions s
      JOIN companies co ON co.id=s.account_id AND co.tenant_id=s.tenant_id AND co.client_id IS NOT DISTINCT FROM s.client_id
      LEFT JOIN scoped c ON c.id=s.contact_id AND c.company_id=s.account_id
    WHERE s.tenant_id=$1 AND s.client_id IS NOT DISTINCT FROM $2::int
       AND ${canonicalInboundSubmissionSql("s")}
      AND ($3::int[] IS NULL OR s.account_id=ANY($3::int[]))
      AND ($4::int IS NULL OR s.contact_id=$4) AND (s.contact_id IS NULL OR c.id IS NOT NULL)
      AND COALESCE(s.identity_review,'')<>'keep'
      AND COALESCE(s.routing_error,'') NOT ILIKE '%email%another account%'
    UNION ALL
    SELECT 'form:'||f.id,c.id,c.name,f.submitted_at,'lead_form','Journey form',
      COALESCE(jf.config->>'title','Form submitted'),NULL,NULL,NULL,NULL,
      jsonb_build_object('field_values',f.field_values,'config',jf.config)::text,
      j.name,p.title,NULL,NULL,false
    FROM form_submissions f JOIN scoped c ON c.id=f.contact_id
      JOIN journeys j ON j.id=f.journey_id AND j.tenant_id=f.tenant_id AND j.client_id IS NOT DISTINCT FROM $2::int
      LEFT JOIN journey_forms jf ON jf.id=f.form_id AND jf.tenant_id=f.tenant_id
      LEFT JOIN journey_pages p ON p.id=f.page_id AND p.journey_id=f.journey_id
    WHERE f.tenant_id=$1
    UNION ALL
    SELECT 'email:'||e.id,c.id,c.name,e.occurred_at,'email_'||regexp_replace(e.event_type,'^email_',''),
      'Email',e.event_type,NULL,NULL,NULL,NULL,e.metadata::text,NULL,NULL,NULL,NULL,e.is_bot
    FROM email_events e JOIN scoped c ON c.id=e.contact_id WHERE e.tenant_id=$1
    UNION ALL
    SELECT DISTINCT ON (je.id) 'journey:'||je.id,c.id,c.name,je.created_at,je.event_type,'Journey browsing',
      je.event_type,NULL,NULL,NULL,NULL,je.props::text,j.name,p.title,NULL,NULL,je.is_bot
    FROM journey_events je JOIN visitor_tokens vt ON vt.token=je.visitor_token AND vt.tenant_id=je.tenant_id
      JOIN scoped c ON c.id=vt.contact_id
      JOIN journeys j ON j.id=je.journey_id AND j.tenant_id=je.tenant_id AND j.client_id IS NOT DISTINCT FROM $2::int
      LEFT JOIN journey_pages p ON p.id=je.page_id AND p.journey_id=je.journey_id
    WHERE je.tenant_id=$1 AND NOT EXISTS (
      SELECT 1 FROM activity_events a WHERE a.tenant_id=je.tenant_id AND a.contact_id=c.id
        AND a.journey_id=je.journey_id AND a.event_type=je.event_type
        AND a.created_at BETWEEN je.created_at-interval '2 seconds' AND je.created_at+interval '2 seconds')
    UNION ALL
    SELECT 'intent-score:'||s.id,c.id,c.name,s.created_at,'intent_score_change','Intent score history',
      COALESCE(s.source,'Intent score recomputed'),s.delta,s.old_score,s.new_score,NULL,NULL,NULL,NULL,NULL,NULL,false
    FROM score_history s JOIN scoped c ON c.id=s.contact_id WHERE s.tenant_id=$1
    UNION ALL
    SELECT 'stage:'||s.id,c.id,c.name,s.created_at,'stage_change','Journey stage history',
      concat_ws(' → ',s.from_stage,s.to_stage),NULL,NULL,NULL,s.to_stage,NULL,NULL,NULL,NULL,NULL,false
    FROM contact_stage_history s JOIN scoped c ON c.id=s.contact_id WHERE s.tenant_id=$1
    UNION ALL
    SELECT 'hp-record:'||r.id,c.id,c.name,r.occurred_at,r.kind,'Recorded engagement',
      COALESCE(r.source_name,r.kind),NULL,NULL,NULL,NULL,NULL,NULL,NULL,r.product,r.status,false
    FROM hp_bi_records r
      JOIN companies co ON co.id=r.account_id AND co.tenant_id=r.tenant_id AND co.client_id IS NOT DISTINCT FROM r.client_id
      LEFT JOIN scoped c ON c.id=r.contact_id AND c.company_id=r.account_id
    WHERE r.tenant_id=$1 AND r.client_id IS NOT DISTINCT FROM $2::int
      AND ($3::int[] IS NULL OR r.account_id=ANY($3::int[]))
      AND ($4::int IS NULL OR r.contact_id=$4) AND (r.contact_id IS NULL OR c.id IS NOT NULL)
      AND COALESCE(r.source_key,'') NOT LIKE 'inbound:%' AND COALESCE(r.source_key,'') NOT LIKE 'form:%'
  ), ordered AS (SELECT * FROM events ORDER BY occurred_at DESC NULLS LAST,id DESC LIMIT $5 OFFSET $6)
  SELECT (SELECT count(*)::int FROM events) total,
    COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY occurred_at DESC NULLS LAST,id DESC) FROM ordered o),'[]'::jsonb) items`,
  [...params, pageSize, (page - 1) * pageSize]);
  const total = Number(result.rows[0]?.total ?? 0);
  const items = (result.rows[0]?.items ?? []).map((r: any) => {
    let metadata: any = {};
    try { metadata = JSON.parse(r.metadata ?? "{}"); } catch { /* historical text is not a tag snapshot */ }
    const fields = r.kind === "lead_form" ? formFields(metadata) : null;
    const qualification = r.source === "Questionnaire / event feedback"
      ? evidenceQualification(r.product, metadata?.horizonMonths, metadata?.classification)
      : fields ? formQualification(metadata) : r.qualification;
    const array = (v: unknown) => Array.isArray(v) ? v.filter(x => typeof x === "string") : [];
    return { id: r.id, contactId: r.contact_id, contactName: r.contact_name || null,
      occurredAt: r.occurred_at, kind: r.kind, source: r.source, description: r.description,
      scoreDelta: r.score_delta, oldScore: r.old_score, newScore: r.new_score, stage: r.stage,
      journey: r.journey, page: r.page, product: fields
        ? text(field(fields, "productInterest", "product", "service", "solution")) || null : r.product, isBot: Boolean(r.bot),
      qualification, dateOrigin: metadata?.dateOrigin ?? null,
      tagsAdded: array(metadata?.tagsAdded ?? metadata?.tags_added ?? metadata?.addedTags),
      tagsRemoved: array(metadata?.tagsRemoved ?? metadata?.tags_removed ?? metadata?.removedTags) };
  });
  return { summary: { score: enriched.score, status: strongestQualification([enriched.status,
      scope.contactId ? "Unqualified" : enriched.statusForAccounts(new Set(scope.companyIds ?? []))]),
    contactsCount: enriched.contacts.length, hotContacts: enriched.contacts.filter(c => c.status === "Hot").length,
    warmContacts: enriched.contacts.filter(c => c.status === "Warm").length, tags: enriched.tags },
    contacts: enriched.contacts, items, total, page, pageSize, hasMore: page * pageSize < total };
}
